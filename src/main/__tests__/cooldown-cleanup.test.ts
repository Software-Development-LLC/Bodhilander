/**
 * The one-time clear of account cooldowns.
 *
 * Cooldowns only ever existed under the detector that read them off rendered
 * terminal output, and that detector marked healthy accounts limited. Every
 * row it left is suspect, so the migration drops all of them — an account
 * genuinely out of quota is marked again at its next refusal, from the CLI's
 * own record.
 *
 * What is worth pinning is that it runs ONCE and touches NOTHING else: it
 * writes to a table the user's accounts live in, and a migration that re-fires
 * would clear a legitimate cooldown written since.
 */
import { describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;
const asDb = (d: Database) => d as unknown as Db;

mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata', isPackaged: false },
}));
mock.module('electron-log', () => ({
  default: { info() {}, warn() {}, error() {} },
  info() {}, warn() {}, error() {},
}));

const { clearCooldownsFromOutputScanning } = await import('../database');

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE claude_accounts (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, config_dir TEXT NOT NULL UNIQUE,
      email TEXT, color TEXT, is_default INTEGER DEFAULT 0,
      created_at TEXT, last_used_at TEXT,
      fallback_rank INTEGER DEFAULT NULL,
      limited_until TEXT DEFAULT NULL, limited_at TEXT DEFAULT NULL
    );
  `);
  const add = db.prepare(
    `INSERT INTO claude_accounts (id, label, config_dir, is_default, created_at, fallback_rank, limited_until, limited_at)
     VALUES (?, ?, ?, 0, '2026-08-01T00:00:00Z', ?, ?, ?)`,
  );
  add.run('a', 'Work', '/cfg/a', 0, '2026-08-26T18:00:00.000Z', '2026-08-25T20:06:24.783Z');
  add.run('b', 'Brannon', '/cfg/b', 1, null, null);
  add.run('c', 'GoBodhi', '/cfg/c', 2, '2026-08-26T18:00:00.000Z', '2026-08-25T20:06:33.044Z');
  return db;
}

const limited = (db: Database) =>
  (db.prepare('SELECT id FROM claude_accounts WHERE limited_until IS NOT NULL').all() as { id: string }[])
    .map((r) => r.id);

describe('clearCooldownsFromOutputScanning', () => {
  test('clears every cooldown, and the timestamp that went with it', () => {
    const db = makeDb();
    expect(limited(db).sort()).toEqual(['a', 'c']);

    clearCooldownsFromOutputScanning(asDb(db));

    expect(limited(db)).toEqual([]);
    const rows = db.prepare('SELECT limited_at FROM claude_accounts').all() as { limited_at: string | null }[];
    expect(rows.every((r) => r.limited_at === null)).toBe(true);
  });

  /**
   * The account rows themselves are the user's setup. A cleanup that reached
   * any further than the two columns it is about would be a worse bug than the
   * one it exists to undo.
   */
  test('leaves everything else about the accounts alone', () => {
    const db = makeDb();
    clearCooldownsFromOutputScanning(asDb(db));

    const rows = db.prepare('SELECT id, label, fallback_rank FROM claude_accounts ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'a', label: 'Work', fallback_rank: 0 },
      { id: 'b', label: 'Brannon', fallback_rank: 1 },
      { id: 'c', label: 'GoBodhi', fallback_rank: 2 },
    ]);
  });

  /**
   * The one that matters on every subsequent launch: a re-fire would clear a
   * cooldown the NEW detector wrote from a real refusal.
   */
  test('does not run a second time', () => {
    const db = makeDb();
    clearCooldownsFromOutputScanning(asDb(db));

    db.prepare("UPDATE claude_accounts SET limited_until = '2026-09-01T00:00:00.000Z' WHERE id = 'b'").run();
    clearCooldownsFromOutputScanning(asDb(db));

    expect(limited(db)).toEqual(['b']);
  });

  test('marks itself done even when there was nothing to clear', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE claude_accounts (id TEXT PRIMARY KEY, label TEXT, config_dir TEXT UNIQUE,
        limited_until TEXT DEFAULT NULL, limited_at TEXT DEFAULT NULL);
    `);
    clearCooldownsFromOutputScanning(asDb(db));
    expect(db.prepare("SELECT 1 FROM preferences WHERE key = 'quotaCooldownsCleared'").get()).toBeTruthy();
  });
});
