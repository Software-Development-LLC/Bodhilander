import { describe, expect, test } from 'bun:test';
import { RunSlots } from '../../run/slots';
import { HIRE, MACHINE, PERSON, crewDb, uuid, type Db } from '../../__tests__/crew-db';
import { RoutineScheduler, latestOccurrence, nextOccurrence, type SchedulerHub } from '../scheduler';
import { parseCron } from '../cron';
import { zonedToUtc } from '../zoned';

const TZ = 'America/Chicago';
const ROUTINE = uuid(900);
const at = (date: string, hhmm: string) => zonedToUtc(date, hhmm, TZ).getTime();

type Sent = { jobId: string; routineId: string; dueAt: number; startedAt: number };

function setup(opts: { cron?: string; lastFired?: number | null; home?: string; state?: string; skewed?: boolean; lease?: boolean; owner?: boolean } = {}) {
  const { db } = crewDb();
  const hire = { name: 'Fresh PO', homeMachineId: opts.home ?? MACHINE, state: opts.state ?? 'active', epoch: 3, ...(opts.owner === false ? {} : { ownerId: PERSON }) };
  db.prepare(`INSERT INTO crew_hire_cache (hire_id, rev, epoch, data) VALUES (?, 1, 3, ?)`).run(HIRE, JSON.stringify(hire));
  const body = { hireId: HIRE, cron: opts.cron ?? '0 8 * * *', timezone: TZ, prompt: 'Post the standup.', lastFired: opts.lastFired === undefined ? at('2026-11-01', '08:00') : opts.lastFired, lastRun: null };
  db.prepare(`INSERT INTO crew_routine_cache (routine_id, hire_id, rev, data) VALUES (?, ?, 1, ?)`).run(ROUTINE, HIRE, JSON.stringify(body));
  const sent: Sent[] = [];
  const told: string[] = [];
  const state = { skewed: opts.skewed ?? false, now: 0 };
  const hub: SchedulerHub = {
    routinesHeldForSkew: () => state.skewed,
    clockSkewMs: () => 3 * 3_600_000,
    canStart: () => opts.lease ?? true,
    knownEpoch: () => 3,
    sendRoutineFired: (jobId, routineId, dueAt, startedAt) => {
      sent.push({ jobId, routineId, dueAt, startedAt });
      return true;
    },
  };
  let queued = 0;
  const scheduler = new RoutineScheduler({ db, hub, machineId: () => MACHINE, tellOwner: (t) => told.push(t), queued: () => (queued += 1), now: () => state.now });
  return { db, scheduler, sent, told, state, queuedCount: () => queued };
}

const jobs = (db: Db) => db.prepare(`SELECT id, kind, scope, epoch, requested_by, text, state FROM crew_job ORDER BY rowid`).all() as {
  id: string; kind: string; scope: string; epoch: number; requested_by: string; text: string; state: string;
}[];
const routineRow = (db: Db) => {
  const r = db.prepare(`SELECT last_fired, data FROM crew_routine_cache WHERE routine_id = ?`).get(ROUTINE) as { last_fired: string; data: string };
  return { lastFiredColumn: Number(r.last_fired), body: JSON.parse(r.data) as { lastFired: number; lastRun: number } };
};

describe('occurrences', () => {
  test('evaluated in the routine zone, across a DST change', () => {
    const cron = parseCron('0 8 * * *');
    const due = latestOccurrence(cron, TZ, null, new Date(at('2026-11-02', '08:30')));
    expect(due?.getTime()).toBe(at('2026-11-02', '08:00'));
    expect(new Date(at('2026-11-02', '08:00')).toISOString()).toBe('2026-11-02T14:00:00.000Z');
    expect(new Date(at('2026-10-30', '08:00')).toISOString()).toBe('2026-10-30T13:00:00.000Z');
    expect(nextOccurrence(cron, TZ, new Date(at('2026-11-02', '08:30')))?.getTime()).toBe(at('2026-11-03', '08:00'));
  });
});

describe('RoutineScheduler', () => {
  test('a routine that missed three firings runs once, late, owner-scoped, with both times in its prompt', () => {
    const s = setup({ lastFired: at('2026-11-01', '08:00') });
    s.state.now = at('2026-11-04', '09:42');
    const fired = s.scheduler.tick();
    expect(fired).toHaveLength(1);
    expect(fired[0].late).toBe(true);
    const [job] = jobs(s.db);
    expect(jobs(s.db)).toHaveLength(1);
    expect(job).toMatchObject({ kind: 'routine', scope: 'owner', epoch: 3, requested_by: PERSON, state: 'queued' });
    expect(job.text).toContain('Post the standup.');
    expect(job.text).toContain('due at 08:00 and is running at 09:42');
    expect(s.sent).toEqual([{ jobId: job.id, routineId: ROUTINE, dueAt: at('2026-11-04', '08:00'), startedAt: s.state.now }]);
    expect(routineRow(s.db)).toEqual({ lastFiredColumn: at('2026-11-04', '08:00'), body: expect.objectContaining({ lastFired: at('2026-11-04', '08:00'), lastRun: s.state.now }) });
    expect(s.queuedCount()).toBe(1);

    s.state.now += 60_000;
    expect(s.scheduler.tick()).toEqual([]);
    expect(jobs(s.db)).toHaveLength(1);
  });

  test('a sync carrying the older lastFired does not fire the same gap again', () => {
    const s = setup({ lastFired: at('2026-11-01', '08:00') });
    s.state.now = at('2026-11-04', '09:42');
    s.scheduler.tick();
    s.db.prepare(`UPDATE crew_routine_cache SET data = json_set(data, '$.lastFired', ?)`).run(at('2026-11-01', '08:00'));
    s.state.now += 60_000;
    expect(s.scheduler.tick()).toEqual([]);
  });

  test('queued messages are picked before the late routine', () => {
    const s = setup();
    s.db.prepare(`INSERT INTO crew_job (id, hire_id, kind, epoch, scope, requested_by, text) VALUES (?, ?, 'message', 3, 'owner', ?, 'hi')`).run(uuid(1), HIRE, PERSON);
    s.state.now = at('2026-11-04', '09:42');
    s.scheduler.tick();
    const queue = jobs(s.db).reverse().map((j) => ({ id: j.id, hireId: HIRE, kind: j.kind === 'routine' ? ('routine' as const) : ('chat' as const) }));
    expect(new RunSlots().pick(queue).map((j) => j.id)).toEqual([uuid(1)]);
  });

  test('a missed firing with the next one within 15 minutes is skipped, and the next one runs on time', () => {
    const s = setup({ cron: '0 9,10 * * *', lastFired: at('2026-11-03', '10:00') });
    s.state.now = at('2026-11-04', '09:50');
    expect(s.scheduler.tick()).toEqual([]);
    expect(jobs(s.db)).toHaveLength(0);
    s.state.now = at('2026-11-04', '10:00') + 30_000;
    const fired = s.scheduler.tick();
    expect(fired).toMatchObject([{ dueAt: at('2026-11-04', '10:00'), late: false }]);
    expect(jobs(s.db)[0].text).toBe('Post the standup.');
  });

  test('a skewed clock holds routines and tells the owner once; they resume when the clock is back', () => {
    const s = setup({ skewed: true });
    s.state.now = at('2026-11-02', '08:00') + 10_000;
    expect(s.scheduler.tick()).toEqual([]);
    expect(s.scheduler.tick()).toEqual([]);
    expect(s.told).toHaveLength(1);
    expect(s.told[0]).toContain('3 h off');
    expect(jobs(s.db)).toHaveLength(0);
    s.state.skewed = false;
    expect(s.scheduler.tick()).toHaveLength(1);
  });

  test('only the home machine with a lease fires, and never for a paused or homeless hire', () => {
    for (const opts of [{ home: uuid(77) }, { lease: false }, { state: 'paused:backstop' }, { state: 'held:no-home' }, { state: 'let_go' }]) {
      const s = setup(opts);
      s.state.now = at('2026-11-02', '08:00') + 10_000;
      expect(s.scheduler.tick()).toEqual([]);
    }
  });

  test('a routine never fired runs on time, never late', () => {
    const late = setup({ lastFired: null });
    late.state.now = at('2026-11-02', '09:42');
    expect(late.scheduler.tick()).toEqual([]);
    const onTime = setup({ lastFired: null });
    onTime.state.now = at('2026-11-02', '08:00') + 30_000;
    expect(onTime.scheduler.tick()).toHaveLength(1);
  });

  test('the owner id falls back to an owner-scope delivery, and with none the routine waits', () => {
    const none = setup({ owner: false });
    none.state.now = at('2026-11-02', '08:00') + 10_000;
    expect(none.scheduler.tick()).toEqual([]);
    none.db.prepare(`INSERT INTO crew_job (id, hire_id, kind, epoch, scope, requested_by, state) VALUES (?, ?, 'message', 3, 'owner', ?, 'done')`).run(uuid(2), HIRE, PERSON);
    expect(none.scheduler.tick()).toHaveLength(1);
    expect(jobs(none.db).find((j) => j.kind === 'routine')?.requested_by).toBe(PERSON);
  });

  test('an unreadable cron or zone is audited once and fires nothing', () => {
    const s = setup({ cron: 'every morning' });
    s.state.now = at('2026-11-02', '08:00');
    expect(s.scheduler.tick()).toEqual([]);
    s.scheduler.tick();
    const audits = s.db.prepare(`SELECT COUNT(*) AS n FROM crew_audit WHERE event = 'routine-unreadable'`).get() as { n: number };
    expect(audits.n).toBe(1);
  });
});
