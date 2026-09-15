/**
 * The run engine's real schema (CO-722).
 *
 * `runs.test.ts` builds its own CREATE TABLE so it can run without electron,
 * which means it proves the repository's SQL agrees with ITSELF. This file
 * executes `initializeRunTables` from database.ts, so a column added in one
 * place and not the other fails here rather than on a user's machine.
 *
 * It also pins the two structural choices the engine depends on and SQLite
 * cannot be made to add later: the cascades, and the composite key that makes
 * the owners mirror re-runnable.
 *
 * Run with: bun test src/main/__tests__/run-schema.test.ts
 */
import { describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;
const asDb = (d: Database) => d as unknown as Db;

// Superset of the electron surface database.ts touches at import time —
// the same shape database-cleanup.test.ts uses, for the same reason.
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
  safeStorage: { isEncryptionAvailable: () => false },
}));
mock.module('electron-log', () => ({
  default: { info() {}, warn() {}, error() {} },
}));

const { initializeRunTables } = await import('../database');

function freshDb(): Database {
  const d = new Database(':memory:');
  d.exec('PRAGMA foreign_keys = ON');
  // runs.group_id references groups(id); the real database always has it.
  d.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  initializeRunTables(asDb(d));
  return d;
}

function columns(d: Database, table: string): string[] {
  return (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name)
    .sort();
}

describe('the schema applies', () => {
  test('creates every table the engine reads', () => {
    const d = freshDb();
    const names = (
      d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const t of ['runs', 'run_owners', 'run_gates', 'run_events']) {
      expect(names).toContain(t);
    }
  });

  test('is re-runnable, because it executes on every launch', () => {
    const d = freshDb();
    expect(() => initializeRunTables(asDb(d))).not.toThrow();
  });

  test('carries the fields that cannot be re-derived later', () => {
    // harness_path and python_path are the two a resumed run cannot work out
    // for itself: three plugin copies were reachable in one 18-hour window,
    // and `python3` on PATH can be a Store alias that is not Python.
    const cols = columns(freshDb(), 'runs');
    for (const c of ['harness_path', 'python_path', 'bodhi_root', 'initiative_key',
      'permission_posture', 'blocked_reason']) {
      expect(cols).toContain(c);
    }
  });

  test('records the permission posture per GATE, not only per run', () => {
    // If you cannot tell afterwards whether an owner ran unsandboxed, you
    // cannot trust what it produced.
    expect(columns(freshDb(), 'run_gates')).toContain('posture');
  });
});

describe('the structural choices SQLite cannot add later', () => {
  test('deleting a run takes its gates, owners and events with it', () => {
    const d = freshDb();
    d.exec("INSERT INTO runs (id, initiative_key, initiative_dir, harness_path, bodhi_root) VALUES ('r', 'K-1', '/i', '/h', '/b')");
    d.exec("INSERT INTO run_owners (run_id, repo, worktree, branch, base) VALUES ('r', 'x', '/w', 'b', 'origin/development')");
    d.exec("INSERT INTO run_gates (id, run_id, gate, agent) VALUES ('g', 'r', 2, 'owner')");
    d.exec("INSERT INTO run_events (run_id, kind) VALUES ('r', 'prepared')");

    d.exec("DELETE FROM runs WHERE id = 'r'");

    for (const t of ['run_owners', 'run_gates', 'run_events']) {
      const n = (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect({ table: t, n }).toEqual({ table: t, n: 0 });
    }
  });

  test('an owner is unique per (run, repo), so re-running spawn cannot duplicate it', () => {
    const d = freshDb();
    d.exec("INSERT INTO runs (id, initiative_key, initiative_dir, harness_path, bodhi_root) VALUES ('r', 'K-1', '/i', '/h', '/b')");
    d.exec("INSERT INTO run_owners (run_id, repo, worktree, branch, base) VALUES ('r', 'x', '/w', 'b', 'origin/development')");
    expect(() =>
      d.exec("INSERT INTO run_owners (run_id, repo, worktree, branch, base) VALUES ('r', 'x', '/w2', 'b2', 'origin/development')"),
    ).toThrow();
  });

  test('the same repo can be owned by two different runs', () => {
    // Two initiatives touching one repo is a merge-order question, not a
    // reason to refuse the second.
    const d = freshDb();
    for (const id of ['r1', 'r2']) {
      d.exec(`INSERT INTO runs (id, initiative_key, initiative_dir, harness_path, bodhi_root) VALUES ('${id}', 'K', '/i', '/h', '/b')`);
      d.exec(`INSERT INTO run_owners (run_id, repo, worktree, branch, base) VALUES ('${id}', 'shared', '/w-${id}', 'b', 'origin/development')`);
    }
    const n = (d.prepare('SELECT COUNT(*) AS n FROM run_owners').get() as { n: number }).n;
    expect(n).toBe(2);
  });

  test('deleting a group leaves the run, because a run is not its sidebar entry', () => {
    const d = freshDb();
    d.exec("INSERT INTO groups (id, name) VALUES ('g1', 'Init')");
    d.exec("INSERT INTO runs (id, initiative_key, initiative_dir, harness_path, bodhi_root, group_id) VALUES ('r', 'K-1', '/i', '/h', '/b', 'g1')");
    d.exec("DELETE FROM groups WHERE id = 'g1'");
    const row = d.prepare("SELECT group_id FROM runs WHERE id = 'r'").get() as {
      group_id: string | null;
    };
    expect(row.group_id).toBeNull();
  });

  test('run_events ids increase, so the log has a stable order', () => {
    // listEvents orders by id rather than by timestamp: CURRENT_TIMESTAMP has
    // second resolution, and several events land inside one second.
    const d = freshDb();
    d.exec("INSERT INTO runs (id, initiative_key, initiative_dir, harness_path, bodhi_root) VALUES ('r', 'K-1', '/i', '/h', '/b')");
    for (const kind of ['a', 'b', 'c']) {
      d.exec(`INSERT INTO run_events (run_id, kind) VALUES ('r', '${kind}')`);
    }
    const ids = (d.prepare('SELECT id FROM run_events ORDER BY id').all() as { id: number }[])
      .map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(3);
  });
});

describe('the multi-owner migration backfills an in-flight database', () => {
  // A database from BEFORE the per-owner columns existed: run_owners without
  // state/blocked_reason/merge_order, run_gates without repo. Everything else is
  // the shipped shape. initializeRunTables must add the columns AND backfill
  // them, or an in-flight run strands the moment the per-owner paths read them.
  function oldDb(): Database {
    const d = new Database(':memory:');
    d.exec('PRAGMA foreign_keys = ON');
    d.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
    d.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, initiative_key TEXT NOT NULL, initiative_dir TEXT NOT NULL,
      harness_path TEXT NOT NULL, bodhi_root TEXT NOT NULL, python_path TEXT,
      state TEXT NOT NULL DEFAULT 'preparing', permission_posture TEXT NOT NULL DEFAULT 'manual',
      budget_usd REAL, group_id TEXT, blocked_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    // run_owners WITHOUT the new columns, but WITH agent (that migration predates this one).
    d.exec(`CREATE TABLE run_owners (
      run_id TEXT NOT NULL, repo TEXT NOT NULL, worktree TEXT NOT NULL, branch TEXT NOT NULL,
      base TEXT NOT NULL, scratch TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'pending',
      pr_number INTEGER, pr_url TEXT, PRIMARY KEY (run_id, repo))`);
    // run_gates WITHOUT repo.
    d.exec(`CREATE TABLE run_gates (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, gate INTEGER NOT NULL, agent TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1, bg_session_id TEXT, claude_session_id TEXT,
      account_id TEXT, status TEXT NOT NULL DEFAULT 'running', verdict_json TEXT,
      receipt_path TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
      posture TEXT NOT NULL DEFAULT 'manual', started_at TEXT DEFAULT CURRENT_TIMESTAMP, ended_at TEXT)`);
    d.exec(`CREATE TABLE run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT DEFAULT CURRENT_TIMESTAMP,
      kind TEXT NOT NULL, gate INTEGER, repo TEXT, payload_json TEXT)`);
    return d;
  }

  function seed(d: Database): void {
    const run = (id: string, state: string) =>
      d.exec(`INSERT INTO runs (id, initiative_key, initiative_dir, harness_path, bodhi_root, state) VALUES ('${id}', 'K', '/i', '/h', '/b', '${state}')`);
    const owner = (run: string, repo: string) =>
      d.exec(`INSERT INTO run_owners (run_id, repo, worktree, branch, base) VALUES ('${run}', '${repo}', '/w', 'b', 'origin/development')`);
    const gate = (id: string, run: string) =>
      d.exec(`INSERT INTO run_gates (id, run_id, gate, agent, status) VALUES ('${id}', '${run}', 2, 'a', 'running')`);
    // A single-owner run mid-flight: backfill both columns.
    run('r1', 'running');
    owner('r1', 'repo-x');
    gate('g1', 'r1');
    // A run still preparing (run-level prelude): owner state stays NULL.
    run('r2', 'preparing');
    owner('r2', 'repo-y');
    // A parked two-owner run: its gate cannot be attributed, so repo stays NULL.
    run('r3', 'running');
    owner('r3', 'repo-p');
    owner('r3', 'repo-q');
    gate('g3', 'r3');
    // A run blocked at migration time: its owner must inherit the state AND the
    // paired reason, or the inbox shows a blocked run with no reason.
    d.exec("INSERT INTO runs (id, initiative_key, initiative_dir, harness_path, bodhi_root, state, blocked_reason) VALUES ('r4', 'K', '/i', '/h', '/b', 'inconclusive', 'gate 2 could not establish a verdict')");
    owner('r4', 'repo-z');
  }

  test('adds the columns and backfills the single-owner run', () => {
    const d = oldDb();
    seed(d);
    initializeRunTables(asDb(d));

    expect(columns(d, 'run_owners')).toEqual(expect.arrayContaining(['state', 'blocked_reason', 'merge_order']));
    expect(columns(d, 'run_gates')).toContain('repo');

    const gate = d.prepare("SELECT repo FROM run_gates WHERE id = 'g1'").get() as { repo: string | null };
    expect(gate.repo).toBe('repo-x');
    const owner = d.prepare("SELECT state FROM run_owners WHERE run_id = 'r1'").get() as { state: string | null };
    expect(owner.state).toBe('running');
  });

  test('backfills a blocked run’s state AND its paired reason onto the owner', () => {
    const d = oldDb();
    seed(d);
    initializeRunTables(asDb(d));
    const owner = d.prepare("SELECT state, blocked_reason FROM run_owners WHERE run_id = 'r4'").get() as {
      state: string | null;
      blocked_reason: string | null;
    };
    expect(owner.state).toBe('inconclusive');
    expect(owner.blocked_reason).toBe('gate 2 could not establish a verdict');
  });

  test('leaves a preparing run’s owner state NULL (prelude stays run-level)', () => {
    const d = oldDb();
    seed(d);
    initializeRunTables(asDb(d));
    const owner = d.prepare("SELECT state FROM run_owners WHERE run_id = 'r2'").get() as { state: string | null };
    expect(owner.state).toBeNull();
  });

  test('does not guess a repo for a gate on a multi-owner run', () => {
    const d = oldDb();
    seed(d);
    initializeRunTables(asDb(d));
    const gate = d.prepare("SELECT repo FROM run_gates WHERE id = 'g3'").get() as { repo: string | null };
    expect(gate.repo).toBeNull();
  });

  test('is idempotent: a second run of the migration changes nothing', () => {
    const d = oldDb();
    seed(d);
    initializeRunTables(asDb(d));
    expect(() => initializeRunTables(asDb(d))).not.toThrow();
    const gate = d.prepare("SELECT repo FROM run_gates WHERE id = 'g1'").get() as { repo: string | null };
    expect(gate.repo).toBe('repo-x');
  });
});
