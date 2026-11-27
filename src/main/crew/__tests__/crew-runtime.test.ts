import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));
mock.module('../../account-identity', () => ({
  resolveAccountIdentity: (dir: string) => ({ loggedIn: true, accountUuid: `u-${dir.split('/').pop()}`, email: 'w@x.com' }),
}));

const { startCrewRuntime, REMINDER_CHECK_MS } = await import('../crew-runtime');
const { CrewSignIn, LOGIN_LIFETIME_MS } = await import('../crew-token');
const { Holds } = await import('../holds');
import type { AccountUsage, ClaudeAccount } from '../../../shared/types';
import type { CrewJob, Prepared, RunChild } from '../run/loop';
import { RunSlots } from '../run/slots';
import { HIRE, PERSON, crewDb, uuid } from './crew-db';

class Child implements RunChild {
  private out: ((l: string) => void)[] = [];
  private close: (() => void)[] = [];
  signals: string[] = [];
  write() {}
  onLine(stream: string, cb: (l: string) => void) {
    if (stream === 'stdout') this.out.push(cb);
  }
  onClose(cb: () => void) {
    this.close.push(cb);
  }
  kill(s: string) {
    this.signals.push(s);
  }
  limited() {
    for (const cb of this.out) cb(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000 } }));
    for (const cb of this.close) cb();
  }
  finish() {
    for (const cb of this.out) cb(JSON.stringify({ type: 'rate_limit_event', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 9e12 } } }));
    for (const cb of this.out) cb(JSON.stringify({ type: 'result', is_error: false, result: 'ok', session_id: 's', usage: { input_tokens: 2 } }));
    for (const cb of this.close) cb();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(over: { prepare?: (job: CrewJob) => Promise<Prepared> } = {}) {
  const { raw, db } = crewDb();
  raw.query(`INSERT INTO claude_accounts (id, label, config_dir) VALUES ('a1', 'Work', '/acct/a1')`).run();
  const accounts = [{ id: 'a1', label: 'Work', configDir: '/acct/a1', email: null } as ClaudeAccount];
  const cipher = { isEncryptionAvailable: () => true, encryptString: (p: string) => Buffer.from(p), decryptString: (b: Buffer) => b.toString() };
  const signIn = new CrewSignIn(db, cipher, false);
  const holds = new Holds();
  const hub = Object.assign(new EventEmitter(), {
    leased: true,
    replies: [] as [string, string][],
    usage: [] as [string, Record<string, unknown>][],
    edits: [] as unknown[],
    canStart: () => hub.leased,
    sendReply: (id: string, text: string) => (hub.replies.push([id, text]), true),
    sendUsage: (id: string, u: Record<string, unknown>) => (hub.usage.push([id, u]), true),
    sendEdit: (e: unknown) => (hub.edits.push(e), 'e1'),
    cards: [] as [string, Record<string, unknown>][],
    sendCard: (id: string, c: Record<string, unknown>) => (hub.cards.push([id, c]), true),
    audits: [] as [string, Record<string, unknown>, string | undefined][],
    sendAudit: (e: string, d: Record<string, unknown>, h?: string) => (hub.audits.push([e, d, h]), 'au1'),
  });
  const ended: string[] = [];
  const children: Child[] = [];
  const records = new Map<string, AccountUsage>();
  const reminders: string[] = [];
  const loggedIn: { a1: boolean | undefined } = { a1: undefined };
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let clock = Date.parse('2026-11-27T12:00:00Z');
  const deps: Parameters<typeof startCrewRuntime>[0] = {
    db, hub, signIn, holds, accounts: () => accounts,
    prepare: over.prepare ?? (async (job) => ({ command: 'claude', args: [], cwd: '/', env: {}, input: job.text, accountId: 'a1', sessionId: null, token: null })),
    usage: { get: (id) => records.get(id) ?? null, set: (u) => void records.set(u.accountId, u) },
    remind: (r, a) => reminders.push(`${a.label}:${r.key}`),
    loggedIn: (a) => (a.id === 'a1' ? loggedIn.a1 : undefined),
    spawn: () => {
      const c = new Child();
      children.push(c);
      return c;
    },
    runEnded: (jobId) => void ended.push(jobId),
    now: () => clock,
    setInterval: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearInterval: (h) => void ((h as { live: boolean }).live = false),
  };
  const rt = startCrewRuntime(deps);
  const job = (n: number) => raw.query(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, text) VALUES (?, ?, 1, 'owner', ?, 'hi')`).run(uuid(n), HIRE, PERSON);
  return { deps, raw, db, hub, rt, children, records, reminders, timers, signIn, holds, job, ended, loggedIn, advance: (ms: number) => (clock += ms) };
}

describe('crew runtime', () => {
  test("a replaced runtime's run still holds its hire and slot, and its end lets the new runtime start the next job", async () => {
    const t = setup();
    const slots = new RunSlots(() => 2);
    let current: ReturnType<typeof startCrewRuntime> | null = null;
    t.rt.stop();
    const first = startCrewRuntime({ ...t.deps, slots, settled: () => void current?.loop.tick() });
    current = first;
    t.job(1);
    t.hub.emit('job');
    await flush();
    expect(t.children).toHaveLength(1);
    first.stop();
    const second = startCrewRuntime({ ...t.deps, slots, settled: () => void current?.loop.tick() });
    current = second;
    t.job(2);
    await second.loop.tick();
    expect(t.children).toHaveLength(1);
    t.children[0].finish();
    await flush();
    await flush();
    expect(t.children).toHaveLength(2);
    expect(second.loop.running()).toEqual([HIRE]);
    expect(first.loop.running()).toEqual([]);
    second.stop();
  });

  test("a run the account's usage limit rejects holds that account until the reported reset", async () => {
    const t = setup();
    t.job(1);
    t.hub.emit('job');
    await flush();
    t.children[0].limited();
    await flush();
    expect(t.holds.rateLimitedUntil('a1', Date.parse('2026-11-27T12:00:00Z'))).toBe(1_900_000_000_000);
    expect(t.hub.replies).toEqual([]);
  });

  test('a delivered job runs; its reply and one usage record go to the Hub, and the window reading reaches the account', async () => {
    const t = setup();
    t.job(1);
    t.hub.emit('job', { id: uuid(1) });
    await flush();
    expect(t.children).toHaveLength(1);
    t.children[0].finish();
    expect(t.hub.replies).toEqual([[uuid(1), 'ok']]);
    expect(t.hub.usage).toEqual([[uuid(1), expect.objectContaining({ accountUuid: 'u-a1', inputTokens: 2, windows: [expect.objectContaining({ name: 'five_hour', utilization: 0.5 })] })]]);
    expect(t.records.get('a1')?.fiveHour?.pct).toBe(50);
  });

  test('a held run is reported to the Hub as a hold audit, once', async () => {
    const t = setup({ prepare: async () => ({ hold: 'held:setup' }) });
    t.job(1);
    t.hub.emit('job', {});
    await flush();
    t.hub.emit('job', {});
    await flush();
    expect(t.hub.audits).toEqual([['hold', { state: 'held:setup' }, HIRE]]);
  });

  test('a renewal starts a job that was waiting for its lease', async () => {
    const t = setup();
    t.hub.leased = false;
    t.job(1);
    t.hub.emit('job', {});
    await flush();
    expect(t.children).toHaveLength(0);
    t.hub.leased = true;
    t.hub.emit('renewed', [HIRE]);
    await flush();
    expect(t.children).toHaveLength(1);
  });

  test('interrupt reaches the running run', async () => {
    const t = setup();
    t.job(1);
    t.hub.emit('job', {});
    await flush();
    t.rt.interrupt(HIRE);
    expect(t.children[0].signals).toEqual(['SIGINT']);
  });

  test('stopHire resolves once the run exits, and kills a run that ignores the interrupt', async () => {
    const t = setup();
    t.job(1);
    t.hub.emit('job', {});
    await flush();
    let stopped = false;
    const stopping = t.rt.stopHire(HIRE, 5).then(() => (stopped = true));
    await flush();
    expect(t.children[0].signals).toEqual(['SIGINT']);
    expect(stopped).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.children[0].signals).toEqual(['SIGINT', 'SIGKILL']);
    t.children[0].finish();
    await stopping;
    expect(stopped).toBe(true);
    await t.rt.stopHire(HIRE, 5);
  });

  test('an applied edit_result carries the account change; welcome settles orphans', () => {
    const t = setup();
    t.raw.query(`INSERT INTO crew_hire_cache (hire_id, rev) VALUES (?, 1)`).run(HIRE);
    t.raw.query(`INSERT INTO crew_thread (hire_id, thread_key, session_id, account_id) VALUES (?, 'chat:owner', NULL, 'a0')`).run(HIRE);
    expect(t.rt.changer.change(HIRE, { id: 'a1', label: 'Work', configDir: '/acct/a1', email: null } as ClaudeAccount)).toEqual({ editId: 'e1' });
    t.hub.emit('edit-result', { type: 'edit_result', id: 'e1', result: 'applied' });
    expect((t.raw.query(`SELECT account_id FROM crew_thread`).get() as { account_id: string }).account_id).toBe('a1');
    t.raw.query(`INSERT INTO crew_sync_state (key, value) VALUES ('account-change:gone', '{"hireId":"h","accountId":"a1","configDir":"/x"}')`).run();
    t.hub.emit('welcome', {});
    expect(t.raw.query(`SELECT key FROM crew_sync_state WHERE key LIKE 'account-change:%'`).all()).toEqual([]);
  });

  test('a login nearing its end reminds once, on the hourly check', () => {
    const t = setup();
    t.signIn.recordSignIn('a1', Date.parse('2026-11-27T12:00:00Z'));
    expect(t.rt.checkReminders()).toBe(0);
    t.advance(LOGIN_LIFETIME_MS - 60_000);
    const hourly = t.timers.find((x) => x.ms === REMINDER_CHECK_MS);
    hourly?.fn();
    hourly?.fn();
    expect(t.reminders).toEqual(['Work:login']);
  });

  test('a login seen on the hourly check starts its reminder clock, with no sign-in recorded through the app', () => {
    const t = setup();
    t.loggedIn.a1 = true;
    t.rt.checkReminders();
    t.advance(LOGIN_LIFETIME_MS - 60_000);
    t.loggedIn.a1 = undefined;
    expect(t.rt.checkReminders()).toBe(1);
    expect(t.reminders).toEqual(['Work:login']);
  });

  test('stop clears the timer, unhooks the Hub and interrupts runs', async () => {
    const t = setup();
    t.job(1);
    t.hub.emit('job', {});
    await flush();
    t.rt.stop();
    expect(t.timers.every((x) => !x.live)).toBe(true);
    expect(t.children[0].signals).toEqual(['SIGINT']);
    expect(t.hub.listenerCount('job')).toBe(0);
  });
});

describe('crew runtime cards', () => {
  test('a run that parks on a card resumes from the decision on the same thread', async () => {
    const t = setup();
    t.job(1);
    t.hub.emit('job', { id: uuid(1) });
    await flush();
    const asked = t.rt.broker.ask({ jobId: uuid(1), hireId: HIRE, threadKey: 'chat:owner', scope: 'owner', requestedBy: PERSON }, { tool_name: 'Bash', input: { command: 'x' } });
    expect(t.hub.cards).toHaveLength(1);
    const [jobId, card] = t.hub.cards[0];
    expect(jobId).toBe(uuid(1));
    expect(card).toMatchObject({ kind: 'permission', inboundId: uuid(1), tainted: false });
    t.rt.loop.park(uuid(1));
    t.children[0].finish();
    await asked;
    await flush();
    expect(t.ended).toEqual([uuid(1)]);
    expect((t.raw.query(`SELECT state FROM crew_job WHERE id = ?`).get(uuid(1)) as { state: string }).state).toBe('parked');
    t.hub.emit('card-decision', { type: 'card_decision', id: uuid(2), hireId: HIRE, epoch: 1, raiseId: card.id, decision: 'approved', decidedBy: PERSON });
    await flush();
    expect(t.children).toHaveLength(2);
    const run = t.raw.query(`SELECT thread_key FROM crew_run WHERE job_id = ?`).get(uuid(2)) as { thread_key: string };
    expect(run.thread_key).toBe('chat:owner');
  });

  test('a card the Hub refused answers the waiting call at once', async () => {
    const t = setup();
    t.job(1);
    t.hub.emit('job', { id: uuid(1) });
    await flush();
    const asked = t.rt.broker.ask({ jobId: uuid(1), hireId: HIRE, threadKey: 'chat:owner', scope: 'owner', requestedBy: PERSON }, { tool_name: 'Bash', input: { command: 'x' } });
    const [, card] = t.hub.cards[0];
    t.hub.emit('card-refused', card.id);
    expect(await asked).toMatchObject({ behavior: 'deny' });
    expect(t.raw.query(`SELECT COUNT(*) AS n FROM crew_card`).get()).toEqual({ n: 0 });
  });

  test('an interrupt while a run waits on a card parks the job; only the decision runs it again', async () => {
    const t = setup();
    t.job(1);
    t.hub.emit('job', { id: uuid(1) });
    await flush();
    void t.rt.broker.ask({ jobId: uuid(1), hireId: HIRE, threadKey: 'chat:owner', scope: 'owner', requestedBy: PERSON }, { tool_name: 'Bash', input: { command: 'x' } });
    const [, card] = t.hub.cards[0];
    t.rt.interrupt(HIRE);
    t.children[0].finish();
    await flush();
    expect(t.raw.query(`SELECT state FROM crew_job WHERE id = ?`).get(uuid(1))).toEqual({ state: 'parked' });
    t.hub.emit('renewed', [{ hireId: HIRE, epoch: 1 }]);
    await flush();
    expect(t.children).toHaveLength(1);
    t.hub.emit('card-decision', { type: 'card_decision', id: uuid(2), hireId: HIRE, epoch: 1, raiseId: card.id, decision: 'approved', decidedBy: PERSON });
    await flush();
    expect(t.children).toHaveLength(2);
  });

  test('a card decision that cannot be handled throws to the Hub client, which then does not ack it', () => {
    const t = setup();
    t.raw.exec('DROP TABLE crew_card');
    expect(() => t.hub.emit('card-decision', { type: 'card_decision', id: uuid(2), hireId: HIRE, epoch: 1, raiseId: uuid(3), decision: 'approved', decidedBy: PERSON })).toThrow();
  });
});
