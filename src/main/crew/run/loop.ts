/**
 * The run loop: queued jobs start in free slots while their lease holds, and
 * each run is settled from its stream. A run finished only on the final
 * `result` event; the exit code is never read, since `claude` exits 0 on SIGINT.
 */
import { spawn as spawnProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import type Database from 'better-sqlite3';
import log from 'electron-log';
import type { UsageObservation } from '../../usage-meter';
import { writeAudit } from '../audit';
import { isAuthFailure } from '../crew-token';
import type { RunScope } from '../protocol';
import { sessionLost } from './sessions';
import type { RunSlots, SlotKind } from './slots';
import { parseRateLimitEvent, parseRejection, runUsage, type RunUsage } from './usage-stream';

export const ERROR_REPLY = 'I hit an error on this one.';
export const MAX_ATTEMPTS = 2;

export interface CrewJob {
  id: string;
  hireId: string;
  kind: 'message' | 'routine' | 'card';
  epoch: number;
  scope: RunScope;
  requestedBy: string;
  sender: string;
  text: string;
  attempts: number;
}

export interface PreparedRun {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  input: string;
  accountId: string;
  sessionId: string | null;
  /** Written to descriptor 3, then closed; null on the login fallback. */
  token: string | null;
}

export type Prepared = PreparedRun | { hold: string };

export interface RunChild {
  readonly pid?: number;
  write(input: string): void;
  onLine(stream: 'stdout' | 'stderr', cb: (line: string) => void): void;
  onClose(cb: () => void): void;
  kill(signal: NodeJS.Signals): void;
}

export interface FinishedRun {
  runId: string;
  job: CrewJob;
  accountId: string;
  startedAt: number;
  durationMs: number;
  model: string;
  usage: RunUsage;
  observation: UsageObservation | null;
}

export type RunOutcome = 'done' | 'interrupted' | 'signed-out' | 'rate-limited' | 'lost-session' | 'held' | 'parked' | 'died' | 'dead';

export interface RunLoopDeps {
  db: Database.Database;
  slots: RunSlots;
  canStart(hireId: string, epoch: number): boolean;
  prepare(job: CrewJob, threadKey: string, runId: string): Promise<Prepared>;
  /** The thread a card job resumes on; other jobs use threadKeyFor. */
  threadKeyOf?(job: CrewJob): string | null;
  spawn(run: PreparedRun): RunChild;
  reply(jobId: string, text: string): boolean;
  onSignedOut(hireId: string, accountId: string): void;
  /** The account's usage limit was hit; runs on it are held until `until`. */
  onRateLimited?(accountId: string, until: number): void;
  onFinished?(run: FinishedRun): void;
  onUsageObserved?(accountId: string, observation: UsageObservation): void;
  onSettled?(jobId: string, outcome: RunOutcome): void;
  /** A run held on an undecided card parks on an interrupt instead of being re-queued. */
  waitingOnCard?(jobId: string): boolean;
  now?(): number;
  newId?(): string;
}

interface Active {
  runId: string;
  job: CrewJob;
  threadKey: string;
  release(): void;
  startedAt: number;
  interrupted: boolean;
  parked: boolean;
  settled: boolean;
  child: RunChild | null;
  prepared: PreparedRun | null;
  result: Record<string, unknown> | null;
  model: string;
  authFailed: boolean;
  stderr: string[];
  observation: UsageObservation | null;
  limitedUntil: number | null;
}

const slotKind = (job: Pick<CrewJob, 'kind'>): SlotKind => (job.kind === 'routine' ? 'routine' : 'chat');

/** One session per run scope, so a circle run never resumes an owner session. */
export function threadKeyFor(job: Pick<CrewJob, 'kind' | 'scope'>): string {
  return `${slotKind(job)}:${job.scope}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class RunLoop {
  private readonly active = new Map<string, Active>();
  private readonly holds = new Map<string, string>();
  private ticking: Promise<number> | null = null;
  private again = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: RunLoopDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  running(): string[] {
    return [...this.active.keys()];
  }

  /** Start what can start now. A call made while a tick runs makes it run once more when it ends. */
  tick(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = this.drain().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** Each job is tried once per tick, and a held hire is not tried again until the next one. */
  private async drain(): Promise<number> {
    const tried = new Set<string>();
    const heldHires = new Set<string>();
    let started = 0;
    do {
      this.again = false;
      started += await this.startQueued(tried, heldHires);
    } while (this.again);
    return started;
  }

  private queued(): CrewJob[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, hire_id, kind, epoch, scope, requested_by, sender, text, attempts FROM crew_job
         WHERE state = 'queued' ORDER BY created_at, rowid`,
      )
      .all() as { id: string; hire_id: string; kind: CrewJob['kind']; epoch: number; scope: RunScope; requested_by: string; sender: string; text: string; attempts: number }[];
    return rows.map((r) => ({
      id: r.id, hireId: r.hire_id, kind: r.kind, epoch: r.epoch, scope: r.scope, requestedBy: r.requested_by, sender: r.sender, text: r.text, attempts: r.attempts,
    }));
  }

  private async startQueued(tried: Set<string>, heldHires: Set<string>): Promise<number> {
    let started = 0;
    for (;;) {
      const jobs = this.queued().filter((j) => !tried.has(j.id) && !heldHires.has(j.hireId) && !this.active.has(j.hireId) && this.deps.canStart(j.hireId, j.epoch));
      const byId = new Map(jobs.map((j) => [j.id, j]));
      const picked = this.deps.slots.pick(jobs.map((j) => ({ id: j.id, hireId: j.hireId, kind: slotKind(j) })));
      if (picked.length === 0) return started;
      for (const { id } of picked) {
        const job = byId.get(id) as CrewJob;
        tried.add(job.id);
        const outcome = await this.start(job);
        if (outcome === 'started') started += 1;
        if (outcome === 'held') heldHires.add(job.hireId);
      }
    }
  }

  private async start(job: CrewJob): Promise<'started' | 'held' | 'skipped'> {
    const slot = this.deps.slots.tryAcquire(job.hireId, slotKind(job));
    if (!slot) return 'skipped';
    const db = this.deps.db;
    const marked = db.prepare(`UPDATE crew_job SET state = 'running', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'queued'`).run(job.id);
    if (marked.changes === 0) {
      slot.release();
      return 'skipped';
    }
    const run: Active = {
      runId: this.newId(), job: { ...job, attempts: job.attempts + 1 }, threadKey: this.deps.threadKeyOf?.(job) ?? threadKeyFor(job), release: () => slot.release(), startedAt: this.now(),
      interrupted: false, parked: false, settled: false, child: null, prepared: null, result: null, model: '', authFailed: false, stderr: [], observation: null, limitedUntil: null,
    };
    this.active.set(job.hireId, run);
    const record = () => db.prepare(`INSERT INTO crew_run (id, job_id, hire_id, thread_key) VALUES (?, ?, ?, ?)`).run(run.runId, job.id, job.hireId, run.threadKey);
    let prepared: Prepared;
    try {
      prepared = await this.deps.prepare(run.job, run.threadKey, run.runId);
    } catch (err) {
      log.warn('[Crew] could not prepare a run', err);
      record();
      this.settle(run);
      return 'started';
    }
    if ('hold' in prepared) {
      this.finishAs(run, 'held', { requeue: true });
      if (this.holds.get(job.hireId) !== prepared.hold) writeAudit(db, job.hireId, 'run-held', { jobId: job.id, hold: prepared.hold });
      this.holds.set(job.hireId, prepared.hold);
      return 'held';
    }
    this.holds.delete(job.hireId);
    record();
    run.prepared = prepared;
    db.prepare(`UPDATE crew_run SET account_id = ?, session_id = ? WHERE id = ?`).run(prepared.accountId, prepared.sessionId, run.runId);
    if (run.interrupted) {
      this.settle(run);
      return 'started';
    }
    try {
      const child = this.deps.spawn(prepared);
      run.child = child;
      if (child.pid !== undefined) db.prepare(`UPDATE crew_run SET pid = ? WHERE id = ?`).run(child.pid, run.runId);
      child.onLine('stdout', (line) => this.onStdout(run, line));
      child.onLine('stderr', (line) => this.onStderr(run, line));
      child.onClose(() => this.settle(run));
      child.write(prepared.input);
    } catch (err) {
      log.warn('[Crew] could not start a run', err);
      this.settle(run);
    }
    return 'started';
  }

  /** Crew's own flag is set before the signal, so the exit is read as interrupted whatever its code. */
  interrupt(hireId: string): boolean {
    const run = this.active.get(hireId);
    if (!run || run.settled) return false;
    run.interrupted = true;
    if (this.deps.waitingOnCard?.(run.job.id)) run.parked = true;
    try {
      run.child?.kill('SIGINT');
    } catch (err) {
      log.warn('[Crew] could not signal a run', err);
    }
    return true;
  }

  /** The run gave up waiting on a card: it ends parked, with no reply, and resumes from the decision. */
  park(jobId: string): boolean {
    const run = [...this.active.values()].find((r) => r.job.id === jobId);
    if (!run || run.settled) return false;
    run.parked = true;
    return true;
  }

  /** Starts nothing more; runs already going still settle. */
  stop(): void {
    this.stopped = true;
  }

  interruptAll(): void {
    for (const hireId of [...this.active.keys()]) this.interrupt(hireId);
  }

  private onStdout(run: Active, line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') run.model = event.model;
    const observation = parseRateLimitEvent(event, this.now());
    if (observation) {
      run.observation = observation;
      this.deps.db.prepare(`UPDATE crew_run SET rate_limit = ? WHERE id = ?`).run(JSON.stringify(observation), run.runId);
      if (run.prepared) this.deps.onUsageObserved?.(run.prepared.accountId, observation);
    }
    const until = parseRejection(event, this.now());
    if (until !== null) run.limitedUntil = Math.max(until, run.limitedUntil ?? 0);
    if (event.type === 'result') run.result = event;
  }

  private onStderr(run: Active, line: string): void {
    run.stderr.push(line);
    if (isAuthFailure(line)) run.authFailed = true;
  }

  private settle(run: Active): void {
    if (run.settled) return;
    const result = run.result;
    const resultText = typeof result?.result === 'string' ? result.result : '';
    if (run.parked) {
      if (result && run.prepared) this.keepSession(run, result);
      return this.finishAs(run, 'parked', { park: true });
    }
    if (run.interrupted) return this.finishAs(run, 'interrupted', { requeue: true });
    if (run.authFailed || (result?.is_error === true && isAuthFailure(resultText))) {
      this.finishAs(run, 'signed-out', { requeue: true });
      if (run.prepared) this.deps.onSignedOut(run.job.hireId, run.prepared.accountId);
      return;
    }
    const ok = !!result && result.is_error !== true && !!run.prepared;
    if (run.limitedUntil !== null && run.prepared) this.deps.onRateLimited?.(run.prepared.accountId, run.limitedUntil);
    if (run.limitedUntil !== null && !ok) return this.finishAs(run, 'rate-limited', { requeue: true });
    if (run.prepared?.sessionId && sessionLost(run.stderr.join('\n'))) {
      this.deps.db.prepare(`UPDATE crew_thread SET session_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE hire_id = ? AND thread_key = ?`).run(run.job.hireId, run.threadKey);
      return this.finishAs(run, 'lost-session', { requeue: true });
    }
    if (ok && result) return this.finishDone(run, result, resultText);
    if (run.job.attempts < MAX_ATTEMPTS) return this.finishAs(run, 'died', { retry: true });
    this.finishAs(run, 'dead', {});
    this.sendReply(run.job.id, ERROR_REPLY);
  }

  private keepSession(run: Active, result: Record<string, unknown>): string | null {
    const prepared = run.prepared as PreparedRun;
    const sessionId = typeof result.session_id === 'string' ? result.session_id : prepared.sessionId;
    this.deps.db
      .prepare(
        `INSERT INTO crew_thread (hire_id, thread_key, session_id, account_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(hire_id, thread_key) DO UPDATE SET session_id = excluded.session_id, account_id = excluded.account_id, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(run.job.hireId, run.threadKey, sessionId, prepared.accountId);
    return sessionId;
  }

  private finishDone(run: Active, result: Record<string, unknown>, text: string): void {
    const prepared = run.prepared as PreparedRun;
    const db = this.deps.db;
    const sessionId = this.keepSession(run, result);
    const usage = runUsage(result);
    db.prepare(`UPDATE crew_run SET session_id = ?, reply_text = ?, usage = ? WHERE id = ?`).run(sessionId, text, JSON.stringify(usage), run.runId);
    this.finishAs(run, 'done', {});
    this.sendReply(run.job.id, text);
    const startedAt = run.startedAt;
    try {
      this.deps.onFinished?.({
        runId: run.runId, job: run.job, accountId: prepared.accountId, startedAt, durationMs: this.now() - startedAt, model: run.model, usage, observation: run.observation,
      });
    } catch (err) {
      log.warn('[Crew] could not report a finished run', err);
    }
  }

  private sendReply(jobId: string, text: string): void {
    try {
      this.deps.reply(jobId, text);
    } catch (err) {
      log.warn('[Crew] could not send a reply', err);
      try {
        this.deps.reply(jobId, ERROR_REPLY);
      } catch (again) {
        log.error('[Crew] could not send the error reply', again);
      }
    }
  }

  /** A requeue gives the attempt back; a retry keeps it spent. A job the fence dropped meanwhile is left dropped. */
  private finishAs(run: Active, outcome: RunOutcome, how: { requeue?: boolean; retry?: boolean; park?: boolean }): void {
    run.settled = true;
    const db = this.deps.db;
    const live = `id = ? AND state IN ('running', 'queued')`;
    if (how.requeue) {
      db.prepare(`UPDATE crew_job SET state = 'queued', attempts = MAX(attempts - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE ${live}`).run(run.job.id);
    } else if (how.park) {
      db.prepare(`UPDATE crew_job SET state = 'parked', updated_at = CURRENT_TIMESTAMP WHERE ${live}`).run(run.job.id);
    } else {
      let state = outcome === 'done' ? 'done' : 'dead';
      if (how.retry) state = 'queued';
      db.prepare(`UPDATE crew_job SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE ${live}`).run(state, run.job.id);
    }
    db.prepare(`UPDATE crew_run SET ended_at = CURRENT_TIMESTAMP, outcome = ?, pid = NULL WHERE id = ?`).run(outcome, run.runId);
    this.active.delete(run.job.hireId);
    run.release();
    this.deps.onSettled?.(run.job.id, outcome);
  }
}

/** The real child: prompt on stdin, the Crew token on descriptor 3 and then closed. */
export function spawnRun(run: PreparedRun): RunChild {
  const child = spawnProcess(run.command, run.args, {
    cwd: run.cwd,
    env: run.env,
    stdio: ['pipe', 'pipe', 'pipe', run.token === null ? 'ignore' : 'pipe'],
  });
  if (run.token !== null) {
    const fd3 = child.stdio[3] as NodeJS.WritableStream | null;
    fd3?.end(`${run.token}\n`);
  }
  const lines = (stream: NodeJS.ReadableStream | null, cb: (line: string) => void) => {
    if (stream) createInterface({ input: stream }).on('line', cb);
  };
  return {
    pid: child.pid,
    write: (input) => child.stdin?.end(input),
    onLine: (stream, cb) => lines(stream === 'stdout' ? child.stdout : child.stderr, cb),
    onClose: (cb) => {
      child.on('close', () => cb());
      child.on('error', (err) => {
        log.warn('[Crew] run process error', err.message);
        cb();
      });
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
}
