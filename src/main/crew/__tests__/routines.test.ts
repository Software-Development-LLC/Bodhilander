import { describe, expect, mock, test } from 'bun:test';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const { editRoutine, routineFields } = await import('../routines');
const { CrewSync } = await import('../sync');
const { RoutineScheduler } = await import('../schedule/scheduler');
import type { RoutineEditDeps, RoutineEditOutcome } from '../routines';
import type { EditFrame } from '../protocol';
import { zonedToUtc } from '../schedule/zoned';
import { HIRE, MACHINE, PERSON, crewDb, uuid, type Db } from './crew-db';

const ROUTINE = uuid(900);
const TZ = 'America/Chicago';
const TRIAGE = { prompt: 'Triage the board and post what needs a decision.', cron: '0 8 * * *', timezone: TZ };

function setup(answer: RoutineEditOutcome = { ok: true, objectId: ROUTINE }, online = true) {
  const { db } = crewDb();
  db.prepare(`INSERT INTO crew_hire_cache (hire_id, rev, epoch, data) VALUES (?, 1, 3, ?)`).run(
    HIRE,
    JSON.stringify({ name: 'Fresh PO', homeMachineId: MACHINE, state: 'active', epoch: 3, ownerId: PERSON }),
  );
  const sync = new CrewSync(db, () => uuid(700));
  const frames: EditFrame[] = [];
  const deps: RoutineEditDeps = {
    online: () => online,
    routineHire: (id) => (db.prepare(`SELECT hire_id FROM crew_routine_cache WHERE routine_id = ?`).get(id) as { hire_id: string } | undefined)?.hire_id ?? null,
    edit: async (input) => (frames.push(sync.buildEdit(input)), answer),
  };
  return { db, deps, frames };
}

function cacheRoutine(db: Db, rev: number, body: Record<string, unknown>): void {
  db.prepare(`INSERT OR REPLACE INTO crew_routine_cache (routine_id, hire_id, rev, data) VALUES (?, ?, ?, ?)`).run(ROUTINE, HIRE, rev, JSON.stringify({ hireId: HIRE, lastFired: null, lastRun: null, ...body }));
}

describe('routine fields', () => {
  test('a five-field cron, an IANA zone and a prompt of 1 to 20000 characters', () => {
    expect(routineFields({ ...TRIAGE, cron: ' 0  8 * * * ' })).toEqual(TRIAGE);
    expect(routineFields({ ...TRIAGE, cron: '0 8 * *' })).toContain('five cron fields');
    expect(routineFields({ ...TRIAGE, cron: '0 8 * * * *' })).toContain('five cron fields');
    expect(routineFields({ ...TRIAGE, cron: '99 8 * * *' })).toContain('five cron fields');
    expect(routineFields({ ...TRIAGE, timezone: 'Mars/Olympus' })).toContain('time zone');
    expect(routineFields({ ...TRIAGE, prompt: '  ' })).toContain('prompt');
    expect(routineFields({ ...TRIAGE, prompt: 'x'.repeat(20_001) })).toContain('prompt');
    expect(routineFields(null)).toContain('five cron fields');
  });
});

describe('routine edits', () => {
  test('create sends the three fields under the hire, with no rev', async () => {
    const t = setup();
    expect(await editRoutine(t.deps, { op: 'create', hireId: HIRE, input: TRIAGE })).toEqual({ ok: true });
    expect(t.frames).toEqual([{ type: 'edit', id: uuid(700), op: 'create', kind: 'routine', fields: TRIAGE, hireId: HIRE }]);
  });

  test('update and delete go at the cached rev', async () => {
    const t = setup();
    cacheRoutine(t.db, 4, TRIAGE);
    await editRoutine(t.deps, { op: 'update', hireId: HIRE, routineId: ROUTINE, input: { ...TRIAGE, cron: '30 7 * * 1-5' } });
    await editRoutine(t.deps, { op: 'delete', hireId: HIRE, routineId: ROUTINE });
    expect(t.frames.map((f) => [f.op, f.objectId, f.rev, f.fields])).toEqual([
      ['update', ROUTINE, 4, { ...TRIAGE, cron: '30 7 * * 1-5' }],
      ['delete', ROUTINE, 4, {}],
    ]);
  });

  test('a conflict and a refusal come back as words, and nothing is sent offline, for bad fields or for another hire\'s routine', async () => {
    const conflict = setup({ ok: false, why: 'conflict' });
    cacheRoutine(conflict.db, 2, TRIAGE);
    expect(await editRoutine(conflict.deps, { op: 'update', hireId: HIRE, routineId: ROUTINE, input: TRIAGE })).toEqual({ ok: false, error: expect.stringContaining('changed somewhere else') });
    expect(await editRoutine(setup({ ok: false, why: 'refused: cron is five fields' }).deps, { op: 'create', hireId: HIRE, input: TRIAGE })).toEqual({ ok: false, error: 'Crew refused the routine (refused: cron is five fields).' });
    const quiet = setup({ ok: true }, false);
    expect((await editRoutine(quiet.deps, { op: 'create', hireId: HIRE, input: TRIAGE })).ok).toBe(false);
    const t = setup();
    expect((await editRoutine(t.deps, { op: 'create', hireId: HIRE, input: { ...TRIAGE, cron: 'daily' } })).ok).toBe(false);
    expect((await editRoutine(t.deps, { op: 'delete', hireId: 'other', routineId: ROUTINE })).ok).toBe(false);
    expect([...quiet.frames, ...t.frames]).toEqual([]);
  });

  test('the 8:00 triage routine, once created and synced, fires through the scheduler at 8:00 in its zone', async () => {
    const t = setup();
    expect(await editRoutine(t.deps, { op: 'create', hireId: HIRE, input: TRIAGE })).toEqual({ ok: true });
    cacheRoutine(t.db, 1, t.frames[0].fields);
    const now = { at: zonedToUtc('2026-11-30', '07:59', TZ).getTime() };
    const fired: string[] = [];
    const scheduler = new RoutineScheduler({
      db: t.db,
      hub: { routinesHeldForSkew: () => false, clockSkewMs: () => 0, canStart: () => true, knownEpoch: () => 3, sendRoutineFired: (_j, routineId) => (fired.push(routineId), true) },
      machineId: () => MACHINE,
      tellOwner: () => {},
      now: () => now.at,
    });
    expect(scheduler.tick()).toEqual([]);
    now.at = zonedToUtc('2026-11-30', '08:00', TZ).getTime();
    const due = scheduler.tick();
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ routineId: ROUTINE, dueAt: now.at, late: false });
    expect(fired).toEqual([ROUTINE]);
    const job = t.db.prepare(`SELECT kind, scope, text FROM crew_job WHERE id = ?`).get(due[0].jobId);
    expect(job).toEqual({ kind: 'routine', scope: 'owner', text: TRIAGE.prompt });
  });
});
