/**
 * Run repository tests (CO-722).
 *
 * The properties that matter are about durability, because a run outlives the
 * process that started it: a state change and its reason must land together or
 * not at all, the event log must stay append-only and in order, and the owners
 * mirror must be re-runnable because spawn.sh is idempotent and will be run
 * again on resume.
 *
 * Uses bun:sqlite (API-compatible with better-sqlite3 for the statements this
 * repo issues) so the suite needs no native build. Mocking '../../database' is
 * the convention every repository test here follows.
 *
 * Run with: bun test src/main/repositories
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

let db: Database;

mock.module('../../database', () => ({
  getDatabase: () => db,
}));

const runs = await import('../runs');
const { RUN_TABLES_SQL } = await import('../../run-tables-sql');
const { NEEDS_A_PERSON } = await import('../../run-engine/transitions');

/**
 * A database with the SHIPPED schema, not a copy of it.
 *
 * This fixture used to declare the four tables itself, which meant a column
 * added in database.ts and missed here produced tests that passed against a
 * schema nobody runs. The SQL now lives in one module that both this and
 * `initializeRunTables` read.
 */
function freshDb(): Database {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);');
  d.exec(RUN_TABLES_SQL);
  return d;
}

const BASE = {
  id: 'run-1',
  initiativeKey: 'BWA-4764',
  initiativeDir: '/root/initiatives/BWA-4764',
  harnessPath: '/plugins/bodhi',
  bodhiRoot: '/root',
};

beforeEach(() => {
  db = freshDb();
});

describe('creating and reading a run', () => {
  test('round-trips every field the engine needs to respawn a gate', () => {
    runs.createRun({
      ...BASE,
      pythonPath: '/usr/bin/python3',
      permissionPosture: 'denyOnPrompt',
      budgetUsd: 12.5,
    });
    const run = runs.getRun('run-1')!;
    // The harness path and the interpreter are the two that cannot be
    // re-derived later: three plugin copies were reachable in one window, and
    // `python3` on PATH can be a Store alias that is not Python.
    expect(run.harnessPath).toBe('/plugins/bodhi');
    expect(run.pythonPath).toBe('/usr/bin/python3');
    expect(run.initiativeKey).toBe('BWA-4764');
    expect(run.permissionPosture).toBe('denyOnPrompt');
    expect(run.budgetUsd).toBe(12.5);
    expect(run.state).toBe('preparing');
  });

  test('a run defaults to prompting, not to bypassing', () => {
    // The default posture decides what an unattended owner may do. Anything
    // but the cautious one being the default is a decision nobody made.
    runs.createRun(BASE);
    expect(runs.getRun('run-1')!.permissionPosture).toBe('manual');
  });

  test('an unknown id is null rather than a throw', () => {
    expect(runs.getRun('nope')).toBeNull();
  });
});

describe('a state change and its reason land together', () => {
  beforeEach(() => runs.createRun(BASE));

  test('recordTransition writes both the state and the event', () => {
    runs.recordTransition('run-1', 'running', 'gateSpawned', { gate: 2 });
    expect(runs.getRun('run-1')!.state).toBe('running');
    const events = runs.listEvents('run-1');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('gateSpawned');
    expect(events[0].gate).toBe(2);
  });

  test('a blocked run records why it stopped', () => {
    runs.recordTransition('run-1', 'inconclusive', 'gateInconclusive', {
      gate: 3,
      blockedReason: 'no verdict written',
    });
    const run = runs.getRun('run-1')!;
    expect(run.state).toBe('inconclusive');
    // Without this the inbox can say a run needs a person and not say why.
    expect(run.blockedReason).toBe('no verdict written');
  });

  test('moving OUT of a blocked state clears the reason', () => {
    runs.recordTransition('run-1', 'inconclusive', 'x', { blockedReason: 'stuck' });
    runs.recordTransition('run-1', 'running', 'resumed');
    expect(runs.getRun('run-1')!.blockedReason).toBeNull();
  });

  test('updated_at moves, so a stalled run is visible as stalled', () => {
    // Backdated rather than compared against "now": the two writes are
    // milliseconds apart and CURRENT_TIMESTAMP has second resolution, so a
    // same-second comparison would assert nothing most of the time.
    //
    // The baseline is read back through the repository rather than parsed
    // from a literal here. SQLite stores CURRENT_TIMESTAMP without a zone and
    // `new Date` reads that as local, so comparing against a `...Z` literal
    // would pass only where the machine happens to be UTC.
    db.exec("UPDATE runs SET updated_at = '2000-01-01 00:00:00' WHERE id = 'run-1'");
    const stale = runs.getRun('run-1')!.updatedAt.getTime();

    runs.recordTransition('run-1', 'running', 'gateSpawned');
    expect(runs.getRun('run-1')!.updatedAt.getTime()).toBeGreaterThan(stale);
  });
});

describe('the event log', () => {
  beforeEach(() => runs.createRun(BASE));

  test('is returned oldest first, because it is a history', () => {
    runs.appendEvent('run-1', 'first');
    runs.appendEvent('run-1', 'second');
    runs.appendEvent('run-1', 'third');
    expect(runs.listEvents('run-1').map((e) => e.kind)).toEqual(['first', 'second', 'third']);
  });

  test('carries structured payloads back as objects', () => {
    runs.appendEvent('run-1', 'verdict', { gate: 3, payload: { verdict: 'pass', findings: [] } });
    expect(runs.listEvents('run-1')[0].payload).toEqual({ verdict: 'pass', findings: [] });
  });

  test('a malformed payload does not take the run view down', () => {
    // The event IS the record; its detail is a convenience. A row written by
    // an older build, or half-written, must still render.
    db.prepare(
      "INSERT INTO run_events (run_id, kind, payload_json) VALUES ('run-1', 'legacy', '{oops')",
    ).run();
    expect(runs.listEvents('run-1')[0].payload).toEqual({ unparsed: '{oops' });
  });

  test('events survive being interleaved with transitions, in one sequence', () => {
    runs.recordTransition('run-1', 'provisioning', 'prepared');
    runs.appendEvent('run-1', 'installOutput', { repo: 'bodhi-web-apps' });
    runs.recordTransition('run-1', 'running', 'provisioned');
    expect(runs.listEvents('run-1').map((e) => e.kind)).toEqual([
      'prepared',
      'installOutput',
      'provisioned',
    ]);
  });
});

describe('the owners mirror', () => {
  beforeEach(() => runs.createRun(BASE));

  const owner = {
    runId: 'run-1',
    repo: 'bodhi-web-apps',
    worktree: '/root/_wt-x-web-apps',
    branch: 'feat/x-web-apps',
    base: 'origin/development',
    scratch: '/root/_wt-x-web-apps-scratch',
    status: 'pending',
    prNumber: null,
    prUrl: null,
  };

  test('is re-runnable, because spawn.sh is idempotent and resume re-runs it', () => {
    runs.upsertOwner(owner);
    runs.upsertOwner({ ...owner, status: 'pushed' });
    const all = runs.listOwners('run-1');
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('pushed');
  });

  test('a re-run does not erase a PR the previous pass recorded', () => {
    // THE CASE THAT MATTERS. spawn.sh is re-run on resume and knows nothing
    // about PRs, so a naive overwrite would drop the one fact only gate 4 had.
    runs.upsertOwner({ ...owner, prNumber: 4764, prUrl: 'https://example/pull/4764' });
    runs.upsertOwner({ ...owner, status: 'verified' });
    const [row] = runs.listOwners('run-1');
    expect(row.prNumber).toBe(4764);
    expect(row.prUrl).toBe('https://example/pull/4764');
    expect(row.status).toBe('verified');
  });

  test('owners are listed per run, not globally', () => {
    runs.createRun({ ...BASE, id: 'run-2' });
    runs.upsertOwner(owner);
    runs.upsertOwner({ ...owner, runId: 'run-2', repo: 'bodhi-service-api' });
    expect(runs.listOwners('run-1').map((o) => o.repo)).toEqual(['bodhi-web-apps']);
    expect(runs.listOwners('run-2').map((o) => o.repo)).toEqual(['bodhi-service-api']);
  });
});

describe('listActiveRuns', () => {
  test('treats approved as finished, because nothing further comes back', () => {
    // Approval, not merge. The wait for someone to press merge is unbounded,
    // and a run sitting there is not something the engine is still doing.
    runs.createRun({ ...BASE, id: 'a' });
    runs.createRun({ ...BASE, id: 'b' });
    runs.createRun({ ...BASE, id: 'c' });
    runs.recordTransition('a', 'running', 'x');
    runs.recordTransition('b', 'approved', 'x');
    runs.recordTransition('c', 'done', 'x');
    expect(runs.listActiveRuns().map((r) => r.id)).toEqual(['a']);
  });

  test('keeps a run that stopped for a person', () => {
    // inconclusive and waitingReview both need someone; neither is finished.
    runs.createRun({ ...BASE, id: 'a' });
    runs.createRun({ ...BASE, id: 'b' });
    runs.recordTransition('a', 'inconclusive', 'x');
    runs.recordTransition('b', 'waitingReview', 'x');
    expect(runs.listActiveRuns().map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  test('drops a failed run', () => {
    runs.createRun({ ...BASE, id: 'a' });
    runs.recordTransition('a', 'failed', 'x');
    expect(runs.listActiveRuns()).toHaveLength(0);
  });
});

describe('the inbox', () => {
  function seed(id: string, state: string, over: { reason?: string; at?: string } = {}): void {
    runs.createRun({
      id,
      initiativeKey: `K-${id}`,
      initiativeDir: `C:/i/${id}`,
      harnessPath: '/plugins/bodhi',
      bodhiRoot: 'C:/work/repos',
      permissionPosture: 'manual',
    });
    db.prepare('UPDATE runs SET state = ?, blocked_reason = ?, updated_at = ? WHERE id = ?')
      .run(state, over.reason ?? null, over.at ?? '2026-09-13T12:00:00Z', id);
  }

  test('every state that needs a person is listed, or deliberately excluded', () => {
    // The tripwire. A state added to NEEDS_A_PERSON and missed here is a run
    // nobody is ever told about, so it must land in the inbox by default --
    // leaving one out has to be a deliberate line in NOT_THE_OPERATOR rather
    // than an omission nobody notices.
    for (const [i, state] of NEEDS_A_PERSON.entries()) seed(`r${i}`, state);
    const listed = runs.listInbox().map((r) => r.state);
    for (const state of NEEDS_A_PERSON) {
      const excluded = runs.NOT_THE_OPERATOR.includes(state);
      expect(listed.includes(state)).toBe(!excluded);
    }
  });

  test('a run waiting on a reviewer is not the operator’s to act on', () => {
    // It needs a person -- but a reviewer working from a queue that already
    // exists, not an operator in this window. An inbox listing things you
    // cannot act on from where you are standing stops being read.
    seed('inreview', 'waitingReview');
    expect(runs.listInbox()).toEqual([]);
  });

  test('and that exclusion is the only one', () => {
    // CONTROL: a growing exclusion list is an inbox quietly becoming empty.
    expect(runs.NOT_THE_OPERATOR).toEqual(['waitingReview']);
  });

  test('a run the engine is working is not in it', () => {
    // The inbox answers "what needs me". A run mid-gate needs nobody, and
    // listing it is how an inbox becomes a list of everything.
    for (const state of ['preparing', 'provisioning', 'running', 'waitingChecks']) {
      seed(`w-${state}`, state);
    }
    expect(runs.listInbox()).toEqual([]);
  });

  test('a run the engine is about to act on is not in it either', () => {
    // reviewNotRequested is a state the engine ACTS on, so a person seeing it
    // would be told to do something the engine is already doing.
    seed('acting', 'reviewNotRequested');
    expect(runs.listInbox()).toEqual([]);
  });

  test('a finished run is not in it', () => {
    for (const state of ['approved', 'done', 'failed']) seed(`f-${state}`, state);
    expect(runs.listInbox()).toEqual([]);
  });

  test('the longest wait comes first', () => {
    // The one waiting longest is the one most likely forgotten, and a
    // newest-first inbox buries it exactly as it becomes urgent.
    seed('recent', 'inconclusive', { at: '2026-09-13T18:00:00Z' });
    seed('ancient', 'waitingHumanGate', { at: '2026-09-10T09:00:00Z' });
    seed('middle', 'waitingPermission', { at: '2026-09-13T12:00:00Z' });
    expect(runs.listInbox().map((r) => r.id)).toEqual(['ancient', 'middle', 'recent']);
  });

  test('a blocked run carries its reason', () => {
    seed('stuck', 'inconclusive', { reason: 'no expected_checks recorded' });
    expect(runs.listInbox()[0].blockedReason).toBe('no expected_checks recorded');
  });

  test('a run merely waiting carries no reason, and that is not a gap', () => {
    // A run parked on a permission prompt has not gone wrong. Inventing a
    // sentence for it would make the column meaningless where it matters.
    seed('waiting', 'waitingPermission');
    expect(runs.listInbox()[0].blockedReason).toBeNull();
  });

  test('the repos it touches come with it', () => {
    // A line a person can recognise. The initiative key alone is a ticket
    // number, and the inbox is read by somebody deciding what to open.
    seed('withrepos', 'inconclusive');
    runs.upsertOwner({
      runId: 'withrepos', repo: 'bodhi-service-api', worktree: 'C:/w', branch: 'b',
      base: 'origin/development', scratch: null, status: 'pending', prNumber: null, prUrl: null,
    });
    expect(runs.listInbox()[0].repos).toEqual(['bodhi-service-api']);
  });

  test('an empty inbox is empty, not a row saying so', () => {
    expect(runs.listInbox()).toEqual([]);
  });

  test('every run keeps its own repos when several are waiting', () => {
    // The owners come back in one query and are grouped by run id. Grouped
    // wrongly, every row would carry the same repos -- which reads as a bug
    // in the engine rather than in the query, because the names would be
    // real ones belonging to a real run.
    seed('one', 'inconclusive', { at: '2026-09-13T10:00:00Z' });
    seed('two', 'waitingHumanGate', { at: '2026-09-13T11:00:00Z' });
    const owner = {
      worktree: 'C:/w', branch: 'b', base: 'origin/development', scratch: null,
      status: 'pending', prNumber: null, prUrl: null,
    };
    runs.upsertOwner({ ...owner, runId: 'one', repo: 'repo-a' });
    runs.upsertOwner({ ...owner, runId: 'two', repo: 'repo-b' });
    runs.upsertOwner({ ...owner, runId: 'two', repo: 'repo-c' });
    expect(runs.listInbox().map((r) => [r.id, r.repos])).toEqual([
      ['one', ['repo-a']],
      ['two', ['repo-b', 'repo-c']],
    ]);
  });
});

describe('a launched gate remembers its session', () => {
  test('both ids land on the row, and the row is still the active gate', () => {
    // Known only after the spawn: the launcher names the session, and the row
    // is opened before the launcher runs. A gate with neither id recorded is
    // a gate nothing can look at again.
    runs.createRun({ ...BASE, pythonPath: null, permissionPosture: 'manual', budgetUsd: null });
    const runId = BASE.id;
    runs.startGate({ id: 'g', runId, gate: 2, agent: 'bsa-lead', posture: 'manual' });
    runs.recordGateSession('g', { claudeSessionId: '4601935b-6a81-4d84-9e0e-ecc0227b3d5f', bgSessionId: '4601935b' });
    const gate = runs.activeGate(runId);
    expect(gate).toMatchObject({
      id: 'g',
      status: 'running',
      claudeSessionId: '4601935b-6a81-4d84-9e0e-ecc0227b3d5f',
      bgSessionId: '4601935b',
    });
  });

  test('a print gate has no background id, and null is recorded as null', () => {
    runs.createRun({ ...BASE, pythonPath: null, permissionPosture: 'manual', budgetUsd: null });
    const runId = BASE.id;
    runs.startGate({ id: 'g', runId, gate: 3, agent: 'reviewer', posture: 'manual' });
    runs.recordGateSession('g', { claudeSessionId: 's-print', bgSessionId: null });
    expect(runs.activeGate(runId)).toMatchObject({ claudeSessionId: 's-print', bgSessionId: null });
  });
});

describe('an owner learns which PR its branch became', () => {
  test('number and URL land together on the owner row', () => {
    runs.createRun({ ...BASE, pythonPath: null, permissionPosture: 'manual', budgetUsd: null });
    runs.upsertOwner({
      runId: BASE.id, repo: 'Bodhilander', worktree: 'C:/wt', branch: 'feat/x', base: 'origin/development',
      scratch: null, agent: 'bodhilander-lead', status: 'pending', prNumber: null, prUrl: null,
    });
    runs.recordOwnerPullRequest(BASE.id, 'Bodhilander', { prNumber: 299, prUrl: 'https://github.com/o/r/pull/299' });
    expect(runs.listOwners(BASE.id)[0]).toMatchObject({ prNumber: 299, prUrl: 'https://github.com/o/r/pull/299' });
  });

  test('another repo’s owner on the same run is untouched', () => {
    runs.createRun({ ...BASE, pythonPath: null, permissionPosture: 'manual', budgetUsd: null });
    for (const repo of ['a-repo', 'b-repo']) {
      runs.upsertOwner({
        runId: BASE.id, repo, worktree: `C:/wt-${repo}`, branch: 'feat/x', base: 'origin/development',
        scratch: null, agent: null, status: 'pending', prNumber: null, prUrl: null,
      });
    }
    runs.recordOwnerPullRequest(BASE.id, 'a-repo', { prNumber: 1, prUrl: 'https://github.com/o/a/pull/1' });
    const owners = runs.listOwners(BASE.id);
    expect(owners.find((o) => o.repo === 'a-repo')?.prNumber).toBe(1);
    expect(owners.find((o) => o.repo === 'b-repo')?.prNumber).toBeNull();
  });
});
