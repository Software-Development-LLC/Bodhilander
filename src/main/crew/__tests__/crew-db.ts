import { Database } from 'bun:sqlite';
import type BetterSqlite3 from 'better-sqlite3';
import { initializeCrewTables } from '../crew-tables-sql';

export type Db = BetterSqlite3.Database;

/** An in-memory database holding the shipped crew SQL, plus the account table it alters. */
export function crewDb(): { raw: Database; db: Db } {
  const raw = new Database(':memory:');
  raw.exec(`CREATE TABLE claude_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, config_dir TEXT NOT NULL UNIQUE, email TEXT)`);
  const db = raw as unknown as Db;
  initializeCrewTables(db);
  return { raw, db };
}

export const HIRE = '11111111-1111-4111-8111-111111111111';
export const HIRE_B = '22222222-2222-4222-8222-222222222222';
export const PERSON = '33333333-3333-4333-8333-333333333333';
export const MACHINE = '44444444-4444-4444-8444-444444444444';

export function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`;
}
