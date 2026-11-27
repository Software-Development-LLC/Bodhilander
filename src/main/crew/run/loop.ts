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
import { parseRateLimitEvent, runUsage, type RunUsage } from './usage-stream';

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

export type RunOutcome = 'done' | 'interrupted' | 'signed-out' | 'lost-session' | 'held' | 'died' | 'dead';

export interface RunLoopDeps {
  db: Database.Database;
  slots: RunSlots;
  canStart(hireId: string, epoch: number): boolean;
  prepare(job: CrewJob, threadKey: string): Promise<Prepared>;
  spawn(run: PreparedRun): RunChild;
  reply(jobId: string, text: string): boolean;
  onSignedOut(hireId: string, accountId: string): void;
  onFinished?(run: FinishedRun): void;
  onUsageObserved?(accountId: string, observation: UsageObservation): void;
  onSettled?(jobId: string, outcome: RunOutcome): void;
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
  settled: boolean;
  child: RunChild | null;
  prepared: PreparedRun | null;
  result: Record<string, unknown> | null;
  model: string;
  authFailed: boolean;
  stderr: string[];
  observation: UsageObservation | null;
}

const slotKind = (job: Pick<CrewJob, 'kind'>): SlotKind => (job.kind === 'routine' ? 'routine' : 'chat');

/** One session per run scope, so a circle run never resumes an owner session. */
export function threadKeyFor(job: Pick<CrewJob, 'kind' | 'scope'>): string {
  return `${slotKind(job)}:${job.scope}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class RunLoop {
  private readonly active = new Map<string, Active>();
  private ticking: Promise<number> | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: RunLoopDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  running(): string[] {
    return [...this.active.keys()];
  }

  /** Start what can start now. Calls made while a tick is in progress share it. */
  tick(): Promise<number> {
    this.ticking ??= this.startQueued().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
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

  private async startQueued(): Promise<number> {
    const jobs = this.queued().filter((j) => !this.active.has(j.hireId) && this.deps.canStart(j.hireId, j.epoch));
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const picked = this.deps.slots.pick(jobs.map((j) => ({ id: j.id, hireId: j.hireId, kind: slotKind(j) })));
    let started = 0;
    for (const { id } of picked) {
      const job = byId.get(id);
      if (job && (await this.start(job))) started += 1;
    }
    return started;
  }

  private async start(job: CrewJob): Promise<boolean> {
    const slot = this.deps.slots.tryAcquire(job.hireId, slotKind(job));
    if (!slot) return false;
    const db = this.deps.db;
    const marked = db.prepare(`UPDATE crew_job SET state = 'running', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'queued'`).run(job.id);
    if (marked.changes === 0) {
      slot.release();
      return false;
    }
    const run: Active = {
      runId: this.newId(), job: { ...job, attempts: job.attempts + 1 }, threadKey: threadKeyFor(job), release: () => slot.release(), startedAt: this.now(),
      interrupted: false, settled: false, child: null, prepared: null, result: null, model: '', authFailed: false, stderr: [], observation: null,
    };
    this.active.set(job.hireId, run);
    db.prepare(`INSERT INTO crew_run (id, job_id, hire_id, thread_key) VALUES (?, ?, ?, ?)`).run(run.runId, job.id, job.hireId, run.threadKey);
    let prepared: Prepared;
    try {
      prepared = await this.deps.prepare(run.job, run.threadKey);
    } catch (err) {
      log.warn('[Crew] could not prepare a run', err);
      this.settle(run);
      return true;
    }
    if ('hold' in prepared) {
      this.finishAs(run, 'held', { requeue: true });
      writeAudit(db, job.hireId, 'run-held', { jobId: job.id, hold: prepared.hold });
      return false;
    }
    run.prepared = prepared;
    db.prepare(`UPDATE crew_run SET account_id = ?, session_id = ? WHERE id = ?`).run(prepared.accountId, prepared.sessionId, run.runId);
    if (run.interrupted) {
      this.settle(run);
      return true;
    }
    try {
      const child = this.deps.spawn(prepared);
      run.child = child;
      child.onLine('stdout', (line) => this.onStdout(run, line));
      child.onLine('stderr', (line) => this.onStderr(run, line));
      child.onClose(() => this.settle(run));
      child.write(prepared.input);
    } catch (err) {
      log.warn('[Crew] could not start a run', err);
      this.settle(run);
    }
    return true;
  }

  /** Crew's own flag is set before the signal, so the exit is read as interrupted whatever its code. */
  interrupt(hireId: string): boolean {
    const run = this.active.get(hireId);
    if (!run || run.settled) return false;
    run.interrupted = true;
    try {
      run.child?.kill('SIGINT');
    } catch (err) {
      log.warn('[Crew] could not signal a run', err);
    }
    return true;
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
    if (run.interrupted) return this.finishAs(run, 'interrupted', { requeue: true });
    if (run.authFailed || (result?.is_error === true && isAuthFailure(resultText))) {
      this.finishAs(run, 'signed-out', { requeue: true });
      if (run.prepared) this.deps.onSignedOut(run.job.hireId, run.prepared.accountId);
      return;
    }
    if (run.prepared?.sessionId && sessionLost(run.stderr.join('\n'))) {
      this.deps.db.prepare(`UPDATE crew_thread SET session_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE hire_id = ? AND thread_key = ?`).run(run.job.hireId, run.threadKey);
      return this.finishAs(run, 'lost-session', { requeue: true });
    }
    if (result && result.is_error !== true && run.prepared) return this.finishDone(run, result, resultText);
    if (run.job.attempts < MAX_ATTEMPTS) return this.finishAs(run, 'died', { retry: true });
    this.finishAs(run, 'dead', {});
    this.deps.reply(run.job.id, ERROR_REPLY);
  }

  private finishDone(run: Active, result: Record<string, unknown>, text: string): void {
    const prepared = run.prepared as PreparedRun;
    const db = this.deps.db;
    const sessionId = typeof result.session_id === 'string' ? result.session_id : prepared.sessionId;
    db.prepare(
      `INSERT INTO crew_thread (hire_id, thread_key, session_id, account_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(hire_id, thread_key) DO UPDATE SET session_id = excluded.session_id, account_id = excluded.account_id, updated_at = CURRENT_TIMESTAMP`,
    ).run(run.job.hireId, run.threadKey, sessionId, prepared.accountId);
    const usage = runUsage(result);
    db.prepare(`UPDATE crew_run SET session_id = ?, reply_text = ?, usage = ? WHERE id = ?`).run(sessionId, text, JSON.stringify(usage), run.runId);
    this.finishAs(run, 'done', {});
    this.deps.reply(run.job.id, text);
    const startedAt = run.startedAt;
    this.deps.onFinished?.({
      runId: run.runId, job: run.job, accountId: prepared.accountId, startedAt, durationMs: this.now() - startedAt, model: run.model, usage, observation: run.observation,
    });
  }

  /** A requeue gives the attempt back; a retry keeps it spent. A job the fence dropped meanwhile is left dropped. */
  private finishAs(run: Active, outcome: RunOutcome, how: { requeue?: boolean; retry?: boolean }): void {
    run.settled = true;
    const db = this.deps.db;
    const live = `id = ? AND state IN ('running', 'queued')`;
    if (how.requeue) {
      db.prepare(`UPDATE crew_job SET state = 'queued', attempts = MAX(attempts - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE ${live}`).run(run.job.id);
    } else {
      let state = outcome === 'done' ? 'done' : 'dead';
      if (how.retry) state = 'queued';
      db.prepare(`UPDATE crew_job SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE ${live}`).run(state, run.job.id);
    }
    db.prepare(`UPDATE crew_run SET ended_at = CURRENT_TIMESTAMP, outcome = ? WHERE id = ?`).run(outcome, run.runId);
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
