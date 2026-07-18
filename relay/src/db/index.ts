import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

export type RelayDb = Database;

/**
 * Open (creating if needed) the relay SQLite database, apply pragmas, and run
 * any pending migrations. The parent directory of `dbPath` is created first.
 *
 * Uses Bun's built-in `bun:sqlite` — no native module to compile, which is why
 * the Docker image is a plain `oven/bun` base with no build toolchain.
 */
export function openDb(dbPath: string): RelayDb {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

/**
 * Apply ordered `NNN_name.sql` migrations from the migrations directory.
 * The schema version is tracked in `PRAGMA user_version`; each migration runs
 * in a transaction and bumps `user_version` to its own number, so re-running
 * is a no-op.
 */
export function runMigrations(db: RelayDb): void {
  const dir = path.join(import.meta.dir, 'migrations');
  const migrations = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => ({ file, version: Number.parseInt(file, 10) }))
    .sort((a, b) => a.version - b.version);

  for (const { file, version } of migrations) {
    if (Number.isNaN(version)) {
      throw new Error(`migration filename must start with a numeric version: ${file}`);
    }
    const current = currentVersion(db);
    if (version <= current) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      // user_version does not accept bound parameters; `version` is a validated
      // integer parsed from the filename above, so interpolation is safe here.
      db.exec(`PRAGMA user_version = ${version};`);
    })();
  }
}

function currentVersion(db: RelayDb): number {
  const row = db.query('PRAGMA user_version;').get() as { user_version: number } | null;
  return row?.user_version ?? 0;
}
