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
