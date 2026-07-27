/**
 * Tests for the one-time reclaims of removed features' tables:
 * dropLegacyCodeSearchTables (code-indexing: chunk source text + 768-dim
 * embeddings) and dropLegacyMemoryTables (memory/context: the memories table
 * plus an FTS5 index holding a second copy of every memory's text).
 *
 * Both run against the database holding the user's real data, so both share the
 * same contract: drop the legacy schema, never touch anything else, run at most
 * once, and never throw.
 *
 * Run with: bun test src/main/__tests__/database-cleanup.test.ts
 */
import { describe, expect, mock, test } from 'bun:test';
// better-sqlite3 is a native module bun:test can't load. bun:sqlite exposes the
// same prepare()/exec()/close() surface this function uses, so we drive it with
// that and cast — the behavior under test is pure SQL.
import { Database } from 'bun:sqlite';
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;
const asDb = (d: Database) => d as unknown as Db;

// Superset of the electron surface database.ts touches at import time.
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
  safeStorage: { isEncryptionAvailable: () => false },
}));
mock.module('electron-log', () => ({
  default: { info() {}, warn() {}, error() {} },
}));

const { dropLegacyCodeSearchTables, dropLegacyMemoryTables } = await import('../database');

/** A db with the legacy code-search tables plus a couple of "real" user tables. */
function makeLegacyDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE code_indexes (id TEXT PRIMARY KEY, directory_path TEXT);
    CREATE TABLE indexed_files (id TEXT PRIMARY KEY, index_id TEXT REFERENCES code_indexes(id));
    CREATE TABLE code_chunks (id TEXT PRIMARY KEY, index_id TEXT REFERENCES code_indexes(id), content TEXT);
    CREATE TABLE symbols (id TEXT PRIMARY KEY, index_id TEXT REFERENCES code_indexes(id), name TEXT);
    CREATE INDEX idx_chunks_index_id ON code_chunks(index_id);
    CREATE INDEX idx_symbols_name ON symbols(name);

    -- the completion marker lives here (same as production)
    CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);

    -- real user data that must survive untouched
    CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, group_id TEXT REFERENCES groups(id), name TEXT);
  `);
  db.prepare("INSERT INTO code_indexes (id, directory_path) VALUES ('i1', '/tmp/x')").run();
  db.prepare("INSERT INTO code_chunks (id, index_id, content) VALUES ('c1','i1','some source')").run();
  db.prepare("INSERT INTO groups (id, name) VALUES ('g1','Work')").run();
  db.prepare("INSERT INTO sessions (id, group_id, name) VALUES ('s1','g1','My Session')").run();
  return db;
}

const tableNames = (db: Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);

describe('dropLegacyCodeSearchTables', () => {
  test('drops every legacy code-search table and reports it did work', () => {
    const db = makeLegacyDb();
    expect(dropLegacyCodeSearchTables(asDb(db))).toBe(true);
    const names = tableNames(db);
    for (const t of ['code_indexes', 'indexed_files', 'code_chunks', 'symbols']) {
      expect(names).not.toContain(t);
    }
    db.close();
  });

  test('leaves real user data completely intact', () => {
    const db = makeLegacyDb();
    dropLegacyCodeSearchTables(asDb(db));
    expect(tableNames(db)).toContain('sessions');
    expect(tableNames(db)).toContain('groups');
    expect(db.prepare('SELECT name FROM sessions WHERE id = ?').get('s1')).toEqual({ name: 'My Session' });
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g1')).toEqual({ name: 'Work' });
    db.close();
  });

  test('drops the legacy indexes along with their tables', () => {
    const db = makeLegacyDb();
    dropLegacyCodeSearchTables(asDb(db));
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[])
      .map((r) => r.name);
    expect(indexes).not.toContain('idx_chunks_index_id');
    expect(indexes).not.toContain('idx_symbols_name');
    db.close();
  });

  test('is a no-op (returns false) on a database with nothing to clean', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT)");
    expect(dropLegacyCodeSearchTables(asDb(db))).toBe(false);
    expect(tableNames(db)).toContain('sessions');
    db.close();
  });

  test('is idempotent — a second run finds nothing and returns false', () => {
    const db = makeLegacyDb();
    expect(dropLegacyCodeSearchTables(asDb(db))).toBe(true);
    expect(dropLegacyCodeSearchTables(asDb(db))).toBe(false);
    db.close();
  });

  test('never throws, even on a closed/unusable database', () => {
    const db = new Database(':memory:');
    db.close();
    expect(() => dropLegacyCodeSearchTables(asDb(db))).not.toThrow();
  });
});

/**
 * A db that also has the vec0 virtual table and its shadow tables (where the
 * embeddings actually live).
 */
function makeVecDb(): Database {
  const db = makeLegacyDb();
  db.exec(`
    CREATE TABLE code_chunks_vec (chunk_id TEXT);            -- stands in for the vec0 vtab
    CREATE TABLE code_chunks_vec_chunks (id INTEGER);        -- shadow: the embedding data
    CREATE TABLE code_chunks_vec_rowids (rowid_ INTEGER);    -- shadow
  `);
  return db;
}

/**
 * Mimic the real world: sqlite-vec is no longer bundled, so DROPping the vec0
 * virtual table ALWAYS raises "no such module: vec0". Shadow tables are ordinary
 * tables and still drop fine.
 */
function withMissingVecModule(db: Database): Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'exec') {
        return (sql: string) => {
          if (sql.trim() === 'DROP TABLE IF EXISTS code_chunks_vec') {
            throw new Error('no such module: vec0');
          }
          return (target as unknown as Record<string, (s: string) => unknown>).exec.call(target, sql);
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Database;
}

describe('dropLegacyCodeSearchTables — vec0 virtual table fallback', () => {
  test('drops the shadow tables (where the embeddings live) when the module is gone', () => {
    const db = makeVecDb();
    expect(dropLegacyCodeSearchTables(asDb(withMissingVecModule(db)))).toBe(true);
    const names = tableNames(db);
    // The actual reclaim: shadow tables holding the embedding data are gone.
    expect(names).not.toContain('code_chunks_vec_chunks');
    expect(names).not.toContain('code_chunks_vec_rowids');
    // Documented limitation: the vtab's own schema row survives (no vec0 module
    // to drop it, and we deliberately don't hand-edit sqlite_master).
    expect(names).toContain('code_chunks_vec');
    db.close();
  });

  test('converges — does NOT re-run (and re-VACUUM) on every later launch', () => {
    const db = makeVecDb();
    const proxied = withMissingVecModule(db);
    expect(dropLegacyCodeSearchTables(asDb(proxied))).toBe(true);
    // Regression guard: code_chunks_vec is STILL in sqlite_master and always
    // will be. Deriving "work remaining" from the schema made this return true
    // forever, re-VACUUMing the whole database on every single app start.
    expect(dropLegacyCodeSearchTables(asDb(proxied))).toBe(false);
    expect(dropLegacyCodeSearchTables(asDb(proxied))).toBe(false);
    db.close();
  });

  test('still preserves real user data on the fallback path', () => {
    const db = makeVecDb();
    dropLegacyCodeSearchTables(asDb(withMissingVecModule(db)));
    expect(db.prepare('SELECT name FROM sessions WHERE id = ?').get('s1')).toEqual({ name: 'My Session' });
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g1')).toEqual({ name: 'Work' });
    db.close();
  });

  test('records the completion marker so the work is genuinely one-time', () => {
    const db = makeVecDb();
    dropLegacyCodeSearchTables(asDb(withMissingVecModule(db)));
    const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get('legacyCodeSearchCleanupDone');
    expect(row).toEqual({ value: 'true' });
    db.close();
  });
});

/**
 * A db carrying the removed memory/context feature's schema — the memories
 * table, the fts5 index (which bun:sqlite builds with the same shadow tables
 * better-sqlite3 does), the three sync triggers, and the '__global__' sentinel
 * group the feature seeded — alongside real user data.
 */
function makeMemoryDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    -- the completion marker lives here (same as production)
    CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);

    -- real user data that must survive untouched
    CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT, "order" INTEGER DEFAULT 0);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
      name TEXT
    );

    -- the removed memory/context feature
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
    CREATE INDEX idx_memories_group ON memories(group_id);
    CREATE VIRTUAL TABLE memories_fts USING fts5(content, content=memories, content_rowid=rowid);
    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END;
    CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
    END;
    CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
      INSERT INTO memories_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END;
  `);
  db.prepare(`INSERT INTO groups (id, name, "order") VALUES ('__global__', 'Global Context', -1)`).run();
  db.prepare(`INSERT INTO groups (id, name, "order") VALUES ('g1', 'Work', 0)`).run();
  db.prepare("INSERT INTO sessions (id, group_id, name) VALUES ('s1','g1','My Session')").run();
  db.prepare("INSERT INTO memories (id, session_id, group_id, content) VALUES ('m1','s1','__global__','remember this')").run();
  return db;
}

const triggerNames = (db: Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map((r) => r.name);

const groupIds = (db: Database): string[] =>
  (db.prepare('SELECT id FROM groups').all() as { id: string }[]).map((r) => r.id);

describe('dropLegacyMemoryTables', () => {
  test('drops memories, the fts5 index and its shadow tables, and reports it did work', () => {
    const db = makeMemoryDb();
    expect(dropLegacyMemoryTables(asDb(db))).toBe(true);
    const names = tableNames(db);
    expect(names).not.toContain('memories');
    expect(names).not.toContain('memories_fts');
    // The fts5 shadow tables are where the duplicated text actually lives —
    // this is what the reclaim is for.
    expect(names.filter((n) => n.startsWith('memories_fts_'))).toEqual([]);
    db.close();
  });

  test('drops the three FTS sync triggers', () => {
    const db = makeMemoryDb();
    dropLegacyMemoryTables(asDb(db));
    expect(triggerNames(db)).toEqual([]);
    db.close();
  });

  test("removes the '__global__' sentinel group the feature seeded", () => {
    const db = makeMemoryDb();
    dropLegacyMemoryTables(asDb(db));
    expect(groupIds(db)).toEqual(['g1']);
    db.close();
  });

  test('leaves real user data completely intact', () => {
    const db = makeMemoryDb();
    dropLegacyMemoryTables(asDb(db));
    const names = tableNames(db);
    expect(names).toContain('sessions');
    expect(names).toContain('groups');
    expect(db.prepare('SELECT name FROM sessions WHERE id = ?').get('s1')).toEqual({ name: 'My Session' });
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g1')).toEqual({ name: 'Work' });
    db.close();
  });

  test("cleans up a database that has the '__global__' group but never stored a memory", () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT);
    `);
    db.prepare("INSERT INTO groups (id, name) VALUES ('__global__','Global Context')").run();
    // The sentinel row alone counts as work — it's invisible in the sidebar and
    // nothing creates it anymore.
    expect(dropLegacyMemoryTables(asDb(db))).toBe(true);
    expect(groupIds(db)).toEqual([]);
    db.close();
  });

  test('is a no-op (returns false) on a database with nothing to clean', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT);
    `);
    db.prepare("INSERT INTO groups (id, name) VALUES ('g1','Work')").run();
    expect(dropLegacyMemoryTables(asDb(db))).toBe(false);
    expect(tableNames(db)).toContain('sessions');
    expect(groupIds(db)).toEqual(['g1']);
    db.close();
  });

  test('is idempotent — a second run finds nothing and returns false', () => {
    const db = makeMemoryDb();
    expect(dropLegacyMemoryTables(asDb(db))).toBe(true);
    expect(dropLegacyMemoryTables(asDb(db))).toBe(false);
    expect(dropLegacyMemoryTables(asDb(db))).toBe(false);
    db.close();
  });

  test('records the completion marker so the work is genuinely one-time', () => {
    const db = makeMemoryDb();
    dropLegacyMemoryTables(asDb(db));
    const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get('legacyMemoryCleanupDone');
    expect(row).toEqual({ value: 'true' });
    db.close();
  });

  test('marks a fresh install done too, so it never looks again', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT)");
    expect(dropLegacyMemoryTables(asDb(db))).toBe(false);
    expect(db.prepare('SELECT value FROM preferences WHERE key = ?').get('legacyMemoryCleanupDone'))
      .toEqual({ value: 'true' });
    db.close();
  });

  test('the marker — not the schema — is what gates the run', () => {
    const db = makeMemoryDb();
    db.prepare("INSERT INTO preferences (key, value) VALUES ('legacyMemoryCleanupDone','true')").run();
    // Legacy schema is right there, but the marker says we already ran: no work,
    // and crucially no VACUUM on every subsequent launch.
    expect(dropLegacyMemoryTables(asDb(db))).toBe(false);
    expect(tableNames(db)).toContain('memories');
    db.close();
  });

  test('never throws, even on a closed/unusable database', () => {
    const db = new Database(':memory:');
    db.close();
    expect(() => dropLegacyMemoryTables(asDb(db))).not.toThrow();
  });
});

describe('the two legacy cleanups are independent', () => {
  test("the code-search marker does not suppress the memory cleanup", () => {
    const db = makeMemoryDb();
    db.prepare("INSERT INTO preferences (key, value) VALUES ('legacyCodeSearchCleanupDone','true')").run();
    expect(dropLegacyCodeSearchTables(asDb(db))).toBe(false);
    // Separate markers: the memory cleanup still has its work to do.
    expect(dropLegacyMemoryTables(asDb(db))).toBe(true);
    expect(tableNames(db)).not.toContain('memories');
    db.close();
  });
});
