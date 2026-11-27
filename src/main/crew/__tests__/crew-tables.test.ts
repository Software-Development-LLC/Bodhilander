import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CREW_TABLES_SQL, initializeCrewTables } from '../crew-tables-sql';
import { crewDb, type Db } from './crew-db';

const TABLES = [
  'crew_hire_cache',
  'crew_role_cache',
  'crew_skill_cache',
  'crew_routine_cache',
  'crew_note',
  'crew_job',
  'crew_run',
  'crew_thread',
  'crew_taint',
  'crew_audit',
  'crew_outbox_local',
  'crew_sync_state',
];

const columns = (raw: Database, table: string) =>
  (raw.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('crew tables', () => {
  test('creates every table the plan names', () => {
    const { raw } = crewDb();
    const names = (raw.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    for (const table of TABLES) expect(names).toContain(table);
  });

  test('a job carries its epoch and run scope, and scope is never defaulted', () => {
    const { raw } = crewDb();
    expect(columns(raw, 'crew_job')).toEqual(expect.arrayContaining(['epoch', 'scope', 'requested_by', 'state']));
    expect(() =>
      raw.exec(`INSERT INTO crew_job (id, hire_id, epoch, requested_by) VALUES ('j', 'h', 1, 'p')`),
    ).toThrow();
    expect(() =>
      raw.exec(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by) VALUES ('j', 'h', 1, 'everyone', 'p')`),
    ).toThrow();
  });

  test('an outbox row records its frame type and protocol version', () => {
    const { raw } = crewDb();
    expect(columns(raw, 'crew_outbox_local')).toEqual(expect.arrayContaining(['frame_type', 'protocol_version', 'epoch', 'hire_id']));
  });

  test('an existing account table gains the Crew token columns, and a second start changes nothing', () => {
    const raw = new Database(':memory:');
    raw.exec(`CREATE TABLE claude_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, config_dir TEXT NOT NULL UNIQUE, email TEXT)`);
    raw.exec(`INSERT INTO claude_accounts (id, label, config_dir) VALUES ('a1', 'Work', '/x')`);
    initializeCrewTables(raw as unknown as Db);
    initializeCrewTables(raw as unknown as Db);
    expect(columns(raw, 'claude_accounts')).toEqual(
      expect.arrayContaining(['crew_token_enc', 'crew_token_created_at', 'crew_token_expires_at']),
    );
    const row = raw.query(`SELECT crew_token_enc FROM claude_accounts WHERE id = 'a1'`).get() as { crew_token_enc: string | null };
    expect(row.crew_token_enc).toBeNull();
  });

  test('a job left running by a quit is queued again at start', () => {
    const { raw, db } = crewDb();
    raw.exec(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, state) VALUES ('j1', 'h', 1, 'owner', 'p', 'running')`);
    raw.exec(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, state) VALUES ('j2', 'h', 1, 'owner', 'p', 'done')`);
    initializeCrewTables(db);
    const states = raw.query(`SELECT id, state FROM crew_job ORDER BY id`).all();
    expect(states).toEqual([
      { id: 'j1', state: 'queued' },
      { id: 'j2', state: 'done' },
    ]);
  });

  test('database.ts calls the crew initializer', async () => {
    const source = await Bun.file(new URL('../../database.ts', import.meta.url)).text();
    expect(source).toContain('initializeCrewTables(db)');
    expect(CREW_TABLES_SQL).toContain('crew_outbox_local');
  });
});
