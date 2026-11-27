import { describe, expect, mock, test } from 'bun:test';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const { ApproveBroker, CARD_HOLD_MS, DENIED_MESSAGE, PARKED_MESSAGE, UNRAISED_MESSAGE, inputHash } = await import('../broker');
import type { CardRaise } from '../broker';
import type { CardDecisionFrame } from '../../protocol';
import { HIRE, PERSON, crewDb, uuid } from '../../__tests__/crew-db';
import { markTainted } from '../../taint';
import { initializeCrewTables } from '../../crew-tables-sql';

const RUN = { jobId: uuid(1), hireId: HIRE, threadKey: 'chat:owner', scope: 'owner' as const, requestedBy: PERSON };

function setup(raises = true) {
  const { raw, db } = crewDb();
  raw.query(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, text, state) VALUES (?, ?, 3, 'owner', ?, 'hi', 'running')`).run(RUN.jobId, HIRE, PERSON);
  const raised: [string, string, CardRaise][] = [];
  const parked: string[] = [];
  const timers: (() => void)[] = [];
  let ids = 0;
  const broker = new ApproveBroker({
    db,
    raiseCard: (jobId, raiseId, raise) => (raises && raised.push([jobId, raiseId, raise]), raises),
    park: (jobId) => parked.push(jobId),
    newId: () => uuid(100 + ++ids),
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => {},
  });
  const decision = (raiseId: string, d: 'approved' | 'denied', id = uuid(200)): CardDecisionFrame => ({
    type: 'card_decision', id, hireId: HIRE, epoch: 3, raiseId, decision: d, decidedBy: PERSON,
  });
  return { raw, db, broker, raised, parked, timers, decision };
}

const ASK = { tool_name: 'Bash', input: { command: 'git push' }, tool_use_id: 'tu-1' };

describe('approve broker', () => {
  test('a request raises a permission card with the tool and its input, tainted as the thread is', async () => {
    const t = setup();
    markTainted(t.db, HIRE, 'chat:owner', 'web_fetch');
    void t.broker.ask(RUN, ASK);
    expect(t.raised).toHaveLength(1);
    const [jobId, , raise] = t.raised[0];
    expect(jobId).toBe(RUN.jobId);
    expect(raise).toEqual({ kind: 'permission', payload: { tool: 'Bash', summary: 'Bash {"command":"git push"}' }, tainted: true });
  });

  test('a decision inside the hold answers the call: approved allows the same input, denied refuses', async () => {
    const t = setup();
    const allowed = t.broker.ask(RUN, ASK);
    expect(t.broker.decide(t.decision(uuid(101), 'approved'))).toBe('answered');
    expect(await allowed).toEqual({ behavior: 'allow', updatedInput: { command: 'git push' } });
    const denied = t.broker.ask(RUN, ASK);
    t.broker.decide(t.decision(uuid(102), 'denied', uuid(201)));
    expect(await denied).toEqual({ behavior: 'deny', message: DENIED_MESSAGE });
    expect(t.parked).toEqual([]);
  });

  test('120 s without a decision parks the run and tells the model to stop', async () => {
    const t = setup();
    expect(CARD_HOLD_MS).toBe(120_000);
    const answer = t.broker.ask(RUN, ASK);
    t.timers[0]();
    expect(await answer).toEqual({ behavior: 'deny', message: PARKED_MESSAGE });
    expect(t.parked).toEqual([RUN.jobId]);
    const card = t.raw.query(`SELECT state FROM crew_card`).get() as { state: string };
    expect(card.state).toBe('parked');
  });

  test('a later decision resumes the parked job as a card job on its thread and scope, once', async () => {
    const t = setup();
    const answer = t.broker.ask(RUN, ASK);
    t.timers[0]();
    await answer;
    t.raw.query(`UPDATE crew_job SET state = 'parked' WHERE id = ?`).run(RUN.jobId);
    expect(t.broker.decide(t.decision(uuid(101), 'approved'))).toBe('job');
    const job = t.raw.query(`SELECT kind, scope, epoch, requested_by, state, text FROM crew_job WHERE id = ?`).get(uuid(200)) as Record<string, unknown>;
    expect(job).toMatchObject({ kind: 'card', scope: 'owner', epoch: 3, requested_by: PERSON, state: 'queued' });
    expect(String(job.text)).toContain('approved');
    expect((t.raw.query(`SELECT state FROM crew_job WHERE id = ?`).get(RUN.jobId) as { state: string }).state).toBe('done');
    expect(t.broker.threadOf(uuid(200))).toBe('chat:owner');
    expect(t.broker.decide(t.decision(uuid(101), 'approved', uuid(202)))).toBeNull();
  });

  test('a restart while a run waits on a card parks the job, so the decision resumes it once and nothing re-runs it', () => {
    const t = setup();
    void t.broker.ask(RUN, ASK);
    initializeCrewTables(t.db);
    expect(t.raw.query(`SELECT state FROM crew_job WHERE id = ?`).get(RUN.jobId)).toEqual({ state: 'parked' });
    expect(t.raw.query(`SELECT state FROM crew_card WHERE raise_id = ?`).get(uuid(101))).toEqual({ state: 'parked' });
    const fresh = new ApproveBroker({ db: t.db, raiseCard: () => true, park: () => {} });
    expect(fresh.decide(t.decision(uuid(101), 'approved'))).toBe('job');
    const states = t.raw.query(`SELECT id, state FROM crew_job ORDER BY id`).all();
    expect(states).toEqual([{ id: RUN.jobId, state: 'done' }, { id: uuid(200), state: 'queued' }]);
  });

  test('the resumed run repeating the approved call is allowed without a second card, and only once', async () => {
    const t = setup();
    const first = t.broker.ask(RUN, ASK);
    t.timers[0]();
    await first;
    t.broker.decide(t.decision(uuid(101), 'approved'));
    const resumed = { ...RUN, jobId: uuid(200) };
    expect(await t.broker.ask(resumed, ASK)).toEqual({ behavior: 'allow', updatedInput: { command: 'git push' } });
    expect(t.raised).toHaveLength(1);
    void t.broker.ask(resumed, ASK);
    expect(t.raised).toHaveLength(2);
  });

  test('a denied decision after a park grants nothing', async () => {
    const t = setup();
    const first = t.broker.ask(RUN, ASK);
    t.timers[0]();
    await first;
    t.broker.decide(t.decision(uuid(101), 'denied'));
    void t.broker.ask({ ...RUN, jobId: uuid(200) }, ASK);
    expect(t.raised).toHaveLength(2);
  });

  test('a card that cannot be raised refuses at once and leaves no card row', async () => {
    const t = setup(false);
    expect(await t.broker.ask(RUN, ASK)).toEqual({ behavior: 'deny', message: UNRAISED_MESSAGE });
    expect(t.raw.query(`SELECT COUNT(*) AS n FROM crew_card`).get()).toEqual({ n: 0 });
  });

  test('an unknown raise id, or another hire, is ignored and audited', () => {
    const t = setup();
    void t.broker.ask(RUN, ASK);
    expect(t.broker.decide({ ...t.decision(uuid(101), 'approved'), hireId: uuid(9) })).toBeNull();
    expect(t.broker.decide(t.decision(uuid(999), 'approved'))).toBeNull();
    const n = t.raw.query(`SELECT COUNT(*) AS n FROM crew_audit WHERE event = 'card-decision-ignored'`).get() as { n: number };
    expect(n.n).toBe(2);
  });

  test('the grant is keyed to the exact input', () => {
    expect(inputHash('Bash', { command: 'a' })).not.toBe(inputHash('Bash', { command: 'b' }));
  });
});
