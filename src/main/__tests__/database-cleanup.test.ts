/**
 * Tests for dropLegacyCodeSearchTables — the one-time reclaim of the removed
 * code-indexing feature's tables. These can be very large (chunk source text +
 * 768-dim embeddings), and this runs against the database holding the user's
 * real data, so the contract is: drop the legacy tables, never touch anything
 * else, and never throw.
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

const { dropLegacyCodeSearchTables } = await import('../database');

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

    -- real user data that must survive untouched
    CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT);
  `);
  db.prepare("INSERT INTO code_indexes (id, directory_path) VALUES ('i1', '/tmp/x')").run();
  db.prepare("INSERT INTO code_chunks (id, index_id, content) VALUES ('c1','i1','some source')").run();
  db.prepare("INSERT INTO sessions (id, name) VALUES ('s1','My Session')").run();
  db.prepare("INSERT INTO memories (id, content) VALUES ('m1','remember this')").run();
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
    expect(tableNames(db)).toContain('memories');
    expect(db.prepare('SELECT name FROM sessions WHERE id = ?').get('s1')).toEqual({ name: 'My Session' });
    expect(db.prepare('SELECT content FROM memories WHERE id = ?').get('m1')).toEqual({ content: 'remember this' });
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
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT)");
    expect(dropLegacyCodeSearchTables(asDb(db))).toBe(false);
    expect(tableNames(db)).toEqual(['sessions']);
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
