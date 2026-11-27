import { describe, expect, mock, test } from 'bun:test';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const { RunLoop, ERROR_REPLY, threadKeyFor } = await import('../loop');
import type { CrewJob, Prepared, PreparedRun, RunChild } from '../loop';
import { RunSlots } from '../slots';
import { HIRE, HIRE_B, PERSON, crewDb, uuid } from '../../__tests__/crew-db';

class FakeChild implements RunChild {
  input: string | null = null;
  signals: string[] = [];
  private readonly lines: Record<string, ((l: string) => void)[]> = {};
  private closers: (() => void)[] = [];
  write(input: string) {
    this.input = input;
  }
  onLine(stream: 'stdout' | 'stderr', cb: (line: string) => void) {
    (this.lines[stream] ??= []).push(cb);
  }
  onClose(cb: () => void) {
    this.closers.push(cb);
  }
  kill(signal: string) {
    this.signals.push(signal);
  }
  out(event: Record<string, unknown>) {
    for (const cb of this.lines.stdout ?? []) cb(JSON.stringify(event));
  }
  err(line: string) {
    for (const cb of this.lines.stderr ?? []) cb(line);
  }
  exit() {
    for (const cb of this.closers) cb();
  }
  finish(text = 'done it', sessionId = 'sess-1') {
    this.out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, usage: { input_tokens: 10, output_tokens: 5 } });
    this.exit();
  }
}

function setup(opts: { maxRuns?: number; leased?: boolean; prepare?: (job: CrewJob) => Promise<Prepared> } = {}) {
  const { raw, db } = crewDb();
  const children: FakeChild[] = [];
  const replies: [string, string][] = [];
  const signedOut: [string, string][] = [];
  const finished: unknown[] = [];
  const observed: unknown[] = [];
  let clock = 1_000;
  let ids = 0;
  const prepared = (job: CrewJob): PreparedRun => ({
    command: 'claude', args: ['-p'], cwd: `/h/${job.hireId}/owner`, env: {}, input: job.text, accountId: 'acct-a', sessionId: null, token: null,
  });
  const loop = new RunLoop({
    db,
    slots: new RunSlots(() => opts.maxRuns ?? 2),
    canStart: () => opts.leased ?? true,
    prepare: opts.prepare ?? (async (job) => prepared(job)),
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    reply: (jobId, text) => (replies.push([jobId, text]), true),
    onSignedOut: (hireId, accountId) => signedOut.push([hireId, accountId]),
    onFinished: (run) => finished.push(run),
    onUsageObserved: (accountId, obs) => observed.push([accountId, obs]),
    now: () => clock,
    newId: () => uuid(500 + ++ids),
  });
  const job = (n: number, hireId = HIRE, kind = 'message') =>
    raw.query(`INSERT INTO crew_job (id, hire_id, kind, epoch, scope, requested_by, text, created_at) VALUES (?, ?, ?, 1, 'owner', ?, ?, ?)`)
      .run(uuid(n), hireId, kind, PERSON, `text ${n}`, `2026-01-01 00:00:${String(n).padStart(2, '0')}`);
  const state = (n: number) => raw.query(`SELECT state, attempts FROM crew_job WHERE id = ?`).get(uuid(n)) as { state: string; attempts: number };
  const lastRun = () => raw.query(`SELECT outcome, account_id, session_id, reply_text FROM crew_run ORDER BY rowid DESC LIMIT 1`).get() as Record<string, unknown>;
  return { raw, loop, children, replies, signedOut, finished, observed, job, state, lastRun, advance: (ms: number) => (clock += ms) };
}

describe('run loop', () => {
  test('a queued job runs, and its final result is the reply; the session is kept for the thread', async () => {
    const t = setup();
    t.job(1);
    expect(await t.loop.tick()).toBe(1);
    expect(t.state(1)).toEqual({ state: 'running', attempts: 1 });
    expect(t.children[0].input).toBe('text 1');
    t.advance(250);
    t.children[0].finish('hello');
    expect(t.state(1).state).toBe('done');
    expect(t.replies).toEqual([[uuid(1), 'hello']]);
    expect(t.lastRun()).toEqual({ outcome: 'done', account_id: 'acct-a', session_id: 'sess-1', reply_text: 'hello' });
    const thread = t.raw.query(`SELECT thread_key, session_id, account_id FROM crew_thread`).get();
    expect(thread).toEqual({ thread_key: 'chat:owner', session_id: 'sess-1', account_id: 'acct-a' });
    expect(t.finished).toEqual([expect.objectContaining({ runId: uuid(501), durationMs: 250, usage: expect.objectContaining({ input_tokens: 10, output_tokens: 5 }) })]);
    expect(t.loop.running()).toEqual([]);
  });

  test('nothing starts without the lease', async () => {
    const t = setup({ leased: false });
    t.job(1);
    expect(await t.loop.tick()).toBe(0);
    expect(t.state(1).state).toBe('queued');
  });

  test('one run per hire and the machine limit; the next starts once a slot frees', async () => {
    const t = setup({ maxRuns: 1 });
    t.job(1);
    t.job(2);
    t.job(3, HIRE_B);
    expect(await t.loop.tick()).toBe(1);
    expect(await t.loop.tick()).toBe(0);
    t.children[0].finish();
    expect(await t.loop.tick()).toBe(1);
    expect(t.state(2).state).toBe('running');
    expect(t.state(3).state).toBe('queued');
  });

  test('an exit without a final result is a run that died: retried once, then dead with the error reply', async () => {
    const t = setup();
    t.job(1);
    await t.loop.tick();
    t.children[0].exit();
    expect(t.state(1)).toEqual({ state: 'queued', attempts: 1 });
    expect(t.replies).toEqual([]);
    await t.loop.tick();
    t.children[1].out({ type: 'result', is_error: true, result: 'boom' });
    t.children[1].exit();
    expect(t.state(1)).toEqual({ state: 'dead', attempts: 2 });
    expect(t.replies).toEqual([[uuid(1), ERROR_REPLY]]);
    expect(t.lastRun().outcome).toBe('dead');
  });

  test('an interrupted run goes back to queued with its attempt given back, and is never posted', async () => {
    const t = setup();
    t.job(1);
    await t.loop.tick();
    expect(t.loop.interrupt(HIRE)).toBe(true);
    expect(t.children[0].signals).toEqual(['SIGINT']);
    t.children[0].finish('half a reply');
    expect(t.state(1)).toEqual({ state: 'queued', attempts: 0 });
    expect(t.replies).toEqual([]);
    expect(t.lastRun().outcome).toBe('interrupted');
    expect(t.loop.interrupt(HIRE)).toBe(false);
  });

  test('an auth failure requeues the job and reports the account signed out', async () => {
    const t = setup();
    t.job(1);
    await t.loop.tick();
    t.children[0].err('API Error: 401 {"type":"error","error":{"type":"authentication_error"}} Unauthorized');
    t.children[0].exit();
    expect(t.state(1)).toEqual({ state: 'queued', attempts: 0 });
    expect(t.signedOut).toEqual([[HIRE, 'acct-a']]);
    expect(t.replies).toEqual([]);
  });

  test('a lost session clears the thread and requeues without spending the retry', async () => {
    const t = setup({ prepare: async (job) => ({ command: 'claude', args: [], cwd: '/', env: {}, input: job.text, accountId: 'acct-a', sessionId: 'old', token: null }) });
    t.raw.query(`INSERT INTO crew_thread (hire_id, thread_key, session_id) VALUES (?, 'chat:owner', 'old')`).run(HIRE);
    t.job(1);
    await t.loop.tick();
    t.children[0].err('No conversation found with session ID: old');
    t.children[0].exit();
    expect(t.state(1)).toEqual({ state: 'queued', attempts: 0 });
    expect((t.raw.query(`SELECT session_id FROM crew_thread`).get() as { session_id: unknown }).session_id).toBeNull();
  });

  test('a hold leaves the job queued and starts nothing', async () => {
    const t = setup({ prepare: async () => ({ hold: 'held:signed-out' }) });
    t.job(1);
    expect(await t.loop.tick()).toBe(0);
    expect(t.state(1)).toEqual({ state: 'queued', attempts: 0 });
    expect(t.children).toHaveLength(0);
    expect(t.raw.query(`SELECT event FROM crew_audit`).all()).toEqual([{ event: 'run-held' }]);
  });

  test('a prepare that throws counts as a run that died', async () => {
    const t = setup({ prepare: async () => { throw new Error('settings write failed'); } });
    t.job(1);
    await t.loop.tick();
    expect(t.state(1)).toEqual({ state: 'queued', attempts: 1 });
    await t.loop.tick();
    expect(t.state(1).state).toBe('dead');
  });

  test('a job the fence dropped mid-run stays dropped and is not posted', async () => {
    const t = setup();
    t.job(1);
    await t.loop.tick();
    t.raw.query(`UPDATE crew_job SET state = 'dropped'`).run();
    t.children[0].exit();
    expect(t.state(1).state).toBe('dropped');
  });

  test('the start-of-run window reading is stored on the run and handed to the account record', async () => {
    const t = setup();
    t.job(1);
    await t.loop.tick();
    t.children[0].out({ type: 'rate_limit_event', unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 2_000_000_000 } } });
    t.children[0].finish();
    expect(t.observed).toEqual([['acct-a', expect.objectContaining({ source: 'run', fiveHour: expect.objectContaining({ pct: 40 }) })]]);
    expect(JSON.parse((t.raw.query(`SELECT rate_limit FROM crew_run`).get() as { rate_limit: string }).rate_limit).fiveHour.pct).toBe(40);
  });

  test('routines and chats keep separate sessions, and so do owner and circle scopes', () => {
    expect(threadKeyFor({ kind: 'message', scope: 'owner' })).toBe('chat:owner');
    expect(threadKeyFor({ kind: 'message', scope: 'circle' })).toBe('chat:circle');
    expect(threadKeyFor({ kind: 'routine', scope: 'owner' })).toBe('routine:owner');
  });
});
