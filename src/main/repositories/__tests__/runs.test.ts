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

function freshDb(): Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);

    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      initiative_key TEXT NOT NULL,
      initiative_dir TEXT NOT NULL,
      harness_path TEXT NOT NULL,
      bodhi_root TEXT NOT NULL,
      python_path TEXT DEFAULT NULL,
      state TEXT NOT NULL DEFAULT 'preparing',
      permission_posture TEXT NOT NULL DEFAULT 'manual',
      budget_usd REAL DEFAULT NULL,
      group_id TEXT DEFAULT NULL REFERENCES groups(id) ON DELETE SET NULL,
      blocked_reason TEXT DEFAULT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE run_owners (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      worktree TEXT NOT NULL,
      branch TEXT NOT NULL,
      base TEXT NOT NULL,
      scratch TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      pr_number INTEGER DEFAULT NULL,
      pr_url TEXT DEFAULT NULL,
      PRIMARY KEY (run_id, repo)
    );

    CREATE TABLE run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      at TEXT DEFAULT CURRENT_TIMESTAMP,
      kind TEXT NOT NULL,
      gate INTEGER DEFAULT NULL,
      repo TEXT DEFAULT NULL,
      payload_json TEXT DEFAULT NULL
    );
  `);
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
