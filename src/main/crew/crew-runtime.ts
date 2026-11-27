/**
 * Crew's moving parts joined to one Hub connection: jobs and renewals start
 * runs, a lease lost interrupts them, finished runs report usage, account
 * changes settle on every connection, and sign-in reminders are checked hourly.
 */
import type { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import log from 'electron-log';
import type { AccountUsage, ClaudeAccount } from '../../shared/types';
import type { UsageObservation } from '../usage-meter';
import { AccountChanger, accountRefFor } from './account-ref';
import { ApproveBroker } from './approve/broker';
import type { CrewSignIn, Reminder } from './crew-token';
import type { Holds } from './holds';
import type { UsageInput } from './hub-client';
import { hireBody, isMoveRaisedHere, moveDecided, type HomeDeps } from './home';
import type { CardDecisionFrame, CardRaiseFrame, EditResultFrame, Unstamped } from './protocol';
import { HOLD_STATES } from './protocol';
import { ERROR_REPLY, RunLoop, spawnRun, type CrewJob, type Prepared, type RunChild, type PreparedRun } from './run/loop';
import { RunSlots } from './run/slots';
import { RoutineScheduler, SCHEDULE_TICK_MS, type SchedulerHub } from './schedule/scheduler';
import type { EditInput } from './sync';
import { mergeRunObservation, usageRecordFor } from './usage-report';

export const REMINDER_CHECK_MS = 60 * 60_000;
/** Just over the Hub's 3 s floor per conversation, so network jitter never makes it drop one. */
export const TYPING_EVERY_MS = 3_500;

export interface CrewHubPort extends Pick<EventEmitter, 'on' | 'off'> {
  canStart(hireId: string, epoch: number): boolean;
  sendReply(jobId: string, text: string): boolean;
  sendUsage(jobId: string, usage: UsageInput): boolean;
  sendAudit(event: string, detail: Record<string, unknown>, hireId?: string): string;
  sendEdit(input: EditInput): string;
  sendCard(jobId: string, raise: Unstamped<CardRaiseFrame>): boolean;
  sendTyping(jobId: string): boolean;
}

export interface CrewRuntimeDeps {
  db: Database.Database;
  hub: CrewHubPort;
  signIn: CrewSignIn;
  holds: Holds;
  accounts(): ClaudeAccount[];
  prepare(job: CrewJob, threadKey: string, runId: string): Promise<Prepared>;
  usage: { get(id: string): AccountUsage | null; set(u: AccountUsage): void };
  remind(reminder: Reminder, account: ClaudeAccount): void;
  /** account-identity's login evidence for the account, so a login made outside the app still starts its reminder clock. */
  loggedIn?(account: ClaudeAccount): boolean | undefined;
  /** A run ended, whatever its outcome: its MCP registration and sockets go with it. */
  runEnded?(jobId: string): void;
  cardHoldMs?: number;
  maxRuns?(): number;
  /** Shared across runtimes, so a replaced runtime's runs still count against the machine and their hires. */
  slots?: RunSlots;
  /** A run ended and freed its slot; the current runtime may start the next job. */
  settled?(): void;
  spawn?(run: PreparedRun): RunChild;
  now?(): number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
  /** Routines fire only where this is given: the Hub client, this machine's id, and a way to tell the owner. */
  schedule?: { hub: SchedulerHub; machineId(): string | null; tellOwner(text: string): void };
  /** Tells the owner how a move card raised here was decided. */
  home?: HomeDeps;
}

export interface CrewRuntime {
  loop: RunLoop;
  changer: AccountChanger;
  broker: ApproveBroker;
  interrupt(hireId: string): void;
  /** Interrupts the hire's run and resolves once it has exited, killing it after the grace period. */
  stopHire(hireId: string, graceMs?: number): Promise<void>;
  checkReminders(): number;
  scheduler: RoutineScheduler | null;
  stop(): void;
  /** The app is quitting: running jobs get their attempt back, then the runtime stops. */
  quit(): void;
}

export const STOP_GRACE_MS = 10_000;

function within(done: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void done.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const isAutomaticHold = (state: unknown): boolean => (HOLD_STATES as readonly unknown[]).includes(state);

/** The crash cap runs before the Hub client exists, so its error replies are owed and sent here. */
export function replyForCrashCapped(db: Database.Database, reply: (jobId: string, text: string) => boolean): void {
  const owed = db.prepare(`SELECT id FROM crew_job WHERE state = 'dead' AND reply_owed = 1`).all() as { id: string }[];
  for (const { id } of owed) {
    if (!reply(id, ERROR_REPLY)) log.warn(`[Crew] the error reply for crash-capped job ${id} could not be queued`);
    db.prepare(`UPDATE crew_job SET reply_owed = 0 WHERE id = ?`).run(id);
  }
}

export function startCrewRuntime(deps: CrewRuntimeDeps): CrewRuntime {
  const now = deps.now ?? Date.now;
  const accountOf = (id: string) => deps.accounts().find((a) => a.id === id) ?? null;
  const inboundOf = (jobId: string): { inboundId?: string } => {
    const row = deps.db.prepare(`SELECT kind FROM crew_job WHERE id = ?`).get(jobId) as { kind: string } | undefined;
    return row?.kind === 'message' ? { inboundId: jobId } : {};
  };
  let loop: RunLoop | null = null;
  const setInt = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearInt = deps.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
  const typingTimers = new Map<string, unknown>();
  const typing = (jobId: string) => {
    try {
      deps.hub.sendTyping(jobId);
    } catch (err) {
      log.warn('[Crew] could not send typing', err);
    }
  };
  const stopTyping = (jobId: string) => {
    if (!typingTimers.has(jobId)) return;
    clearInt(typingTimers.get(jobId));
    typingTimers.delete(jobId);
  };
  const reportedHold = new Map<string, string>();
  const broker = new ApproveBroker({
    db: deps.db,
    raiseCard: (jobId, raiseId, raise) => deps.hub.sendCard(jobId, { id: raiseId, ...raise, ...inboundOf(jobId) }),
    park: (jobId) => {
      loop?.park(jobId);
    },
    holdMs: deps.cardHoldMs,
  });
  loop = new RunLoop({
    db: deps.db,
    slots: deps.slots ?? new RunSlots(deps.maxRuns),
    canStart: (hireId, epoch) => deps.hub.canStart(hireId, epoch),
    prepare: deps.prepare,
    threadKeyOf: (job) => (job.kind === 'card' ? broker.threadOf(job.id) : null),
    spawn: deps.spawn ?? spawnRun,
    reply: (jobId, text) => deps.hub.sendReply(jobId, text),
    onSignedOut: (_hireId, accountId) => deps.signIn.recordAuthFailure(accountId, now()),
    onRateLimited: (accountId, until) => deps.holds.recordRateLimit(accountId, until),
    onUsageObserved: (accountId: string, observation: UsageObservation) => {
      mergeRunObservation(accountId, observation, deps.usage);
    },
    onFinished: (run) => {
      const account = accountOf(run.accountId);
      const uuid = account ? accountRefFor(account).accountUuid : null;
      if (!uuid) return log.warn('[Crew] a finished run has no account uuid; its usage is not reported');
      deps.hub.sendUsage(run.job.id, usageRecordFor(run, uuid, deps.usage.get(run.accountId)));
    },
    onHeld: (hireId, hold) => {
      if (!isAutomaticHold(hold)) return;
      deps.hub.sendAudit('hold', { state: hold }, hireId);
      reportedHold.set(hireId, hold);
    },
    onUnheld: (hireId) => {
      if (!isAutomaticHold(reportedHold.get(hireId) ?? hireBody(deps.db, hireId)?.state)) return;
      guard('reporting a hold release', () => deps.hub.sendAudit('hold', { state: 'active' }, hireId));
      reportedHold.set(hireId, 'active');
    },
    onWorking: (job) => {
      if (job.kind !== 'message' || typingTimers.has(job.id)) return;
      typing(job.id);
      typingTimers.set(job.id, setInt(() => typing(job.id), TYPING_EVERY_MS));
    },
    onSettled: (jobId, outcome) => {
      stopTyping(jobId);
      broker.release(jobId, outcome);
      guard('ending a run', () => deps.runEnded?.(jobId));
      if (outcome === 'held') return;
      void tick();
      guard('starting the next run', () => deps.settled?.());
    },
    waitingOnCard: (jobId) => broker.waitingFor(jobId),
    now,
  });
  const changer = new AccountChanger({
    db: deps.db,
    sendEdit: (input) => deps.hub.sendEdit(input),
    configDirOf: (id) => accountOf(id)?.configDir ?? null,
  });

  const guard = (what: string, fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      log.error(`[Crew] ${what} failed`, err);
    }
  };
  const runLoop = loop;
  const tick = () => runLoop.tick().catch((err) => log.error('[Crew] the run loop failed', err));
  const settle = () => guard('settling account changes', () => changer.settle());
  const onEditResult = (frame: EditResultFrame): void => guard('carrying sessions', () => changer.onEditResult(frame));
  /** Not guarded: a decision that throws reaches the Hub client, which leaves it unacked to come again. */
  const onCardDecision = (frame: CardDecisionFrame): void => {
    if (deps.home && isMoveRaisedHere(deps.db, frame)) return moveDecided(deps.home, frame);
    if (broker.decide(frame) === 'job') void tick();
  };
  const onCardRefused = (raiseId: string): void => guard('a refused card', () => broker.refused(raiseId));

  const checkReminders = (): number => {
    let sent = 0;
    for (const account of deps.accounts()) {
      guard('a sign-in reminder', () => {
        if (deps.loggedIn) deps.signIn.observeLogin(account.id, deps.loggedIn(account), now());
        for (const reminder of deps.signIn.dueReminders(account.id, now())) {
          deps.remind(reminder, account);
          sent += 1;
        }
      });
    }
    return sent;
  };

  const listeners: [string, Parameters<EventEmitter['on']>[1]][] = [
    ['job', tick],
    ['renewed', tick],
    [
      'welcome',
      () => {
        settle();
        tick();
      },
    ],
    ['epoch', settle],
    ['revoked', settle],
    ['sync-needed', settle],
    ['edit-result', onEditResult],
    ['card-decision', onCardDecision],
    ['card-refused', onCardRefused],
  ];
  const schedule = deps.schedule;
  const scheduler = schedule
    ? new RoutineScheduler({ db: deps.db, hub: schedule.hub, machineId: schedule.machineId, tellOwner: schedule.tellOwner, queued: () => void tick(), now })
    : null;
  const fireRoutines = () => guard('firing routines', () => scheduler?.tick());
  if (scheduler) listeners.push(['renewed', fireRoutines]);
  const scheduleTimer = scheduler ? setInt(fireRoutines, SCHEDULE_TICK_MS) : null;
  for (const [event, fn] of listeners) deps.hub.on(event, fn);
  settle();
  guard('replying for crash-capped jobs', () => replyForCrashCapped(deps.db, (jobId, text) => deps.hub.sendReply(jobId, text)));
  const reminderTimer = setInt(() => {
    checkReminders();
  }, REMINDER_CHECK_MS);
  checkReminders();
  const stop = () => {
    clearInt(reminderTimer);
    if (scheduleTimer !== null) clearInt(scheduleTimer);
    for (const [event, fn] of listeners) deps.hub.off(event, fn);
    for (const jobId of [...typingTimers.keys()]) stopTyping(jobId);
    runLoop.stop();
    broker.stop();
    runLoop.interruptAll();
  };

  return {
    loop: runLoop,
    changer,
    broker,
    interrupt: (hireId) => {
      runLoop.interrupt(hireId);
    },
    stopHire: async (hireId, graceMs = STOP_GRACE_MS) => {
      runLoop.interrupt(hireId);
      if (await within(runLoop.whenIdle(hireId), graceMs)) return;
      runLoop.kill(hireId);
      await within(runLoop.whenIdle(hireId), graceMs);
    },
    checkReminders,
    scheduler,
    stop,
    quit: () => {
      runLoop.stop();
      runLoop.returnAttempts();
      stop();
    },
  };
}
