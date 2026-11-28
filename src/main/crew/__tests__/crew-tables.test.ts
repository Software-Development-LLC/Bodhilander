import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CREW_JOB_MAX_ATTEMPTS as MAX_ATTEMPTS, CREW_TABLES_SQL, initializeCrewTables } from '../crew-tables-sql';
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

  test('an existing crew_run table gains the pid column', () => {
    const raw = new Database(':memory:');
    raw.exec(`CREATE TABLE claude_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, config_dir TEXT NOT NULL UNIQUE, email TEXT)`);
    raw.exec(`CREATE TABLE crew_run (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, hire_id TEXT NOT NULL, ended_at TEXT DEFAULT NULL)`);
    initializeCrewTables(raw as unknown as Db);
    expect(columns(raw, 'crew_run')).toContain('pid');
  });

  test('a job left running by a quit or crash is queued again at start, and that attempt counts', () => {
    const { raw, db } = crewDb();
    raw.exec(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, state, attempts) VALUES ('j1', 'h', 1, 'owner', 'p', 'running', 1)`);
    raw.exec(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, state) VALUES ('j2', 'h', 1, 'owner', 'p', 'done')`);
    initializeCrewTables(db);
    expect(raw.query(`SELECT id, state, attempts FROM crew_job ORDER BY id`).all()).toEqual([
      { id: 'j1', state: 'queued', attempts: 1 },
      { id: 'j2', state: 'done', attempts: 0 },
    ]);
  });

  test('a job that keeps crashing the app stops at the retry limit, and says so in the audit', () => {
    const { raw, db } = crewDb();
    raw.exec(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, state, attempts) VALUES ('j1', 'h', 1, 'owner', 'p', 'running', 1)`);
    for (let restart = 0; restart < 4; restart += 1) {
      initializeCrewTables(db);
      raw.exec(`UPDATE crew_job SET state = 'running', attempts = attempts + 1 WHERE id = 'j1' AND state = 'queued'`);
    }
    expect(raw.query(`SELECT state, attempts FROM crew_job WHERE id = 'j1'`).get()).toEqual({ state: 'dead', attempts: MAX_ATTEMPTS });
    const audits = raw.query(`SELECT hire_id, event, detail FROM crew_audit WHERE event = 'job-crash-limit'`).all() as { hire_id: string; detail: string }[];
    expect(audits).toHaveLength(1);
    expect(audits[0].hire_id).toBe('h');
    expect(JSON.parse(audits[0].detail)).toEqual({ jobId: 'j1', attempts: MAX_ATTEMPTS });
    expect(raw.query(`SELECT reply_owed FROM crew_job WHERE id = 'j1'`).get()).toEqual({ reply_owed: 1 });
  });

  test('a job requeued under the limit owes no reply, and an existing crew_job gains reply_owed', () => {
    const raw = new Database(':memory:');
    raw.exec(`CREATE TABLE claude_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, config_dir TEXT NOT NULL UNIQUE, email TEXT)`);
    raw.exec(`CREATE TABLE crew_job (id TEXT PRIMARY KEY, hire_id TEXT NOT NULL, epoch INTEGER NOT NULL, scope TEXT NOT NULL, requested_by TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT)`);
    raw.exec(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, state, attempts) VALUES ('j1', 'h', 1, 'owner', 'p', 'running', 1)`);
    initializeCrewTables(raw as unknown as Db);
    expect(raw.query(`SELECT state, reply_owed FROM crew_job WHERE id = 'j1'`).get()).toEqual({ state: 'queued', reply_owed: 0 });
  });

  test('a job a clean quit left running is queued again at start, never capped', () => {
    const { raw, db } = crewDb();
    raw.exec(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, state, attempts, quit_clean) VALUES ('j1', 'h', 1, 'owner', 'p', 'running', ${MAX_ATTEMPTS}, 1)`);
    initializeCrewTables(db);
    expect(raw.query(`SELECT state, attempts, reply_owed, quit_clean FROM crew_job WHERE id = 'j1'`).get()).toEqual({ state: 'queued', attempts: MAX_ATTEMPTS, reply_owed: 0, quit_clean: 0 });
    expect(raw.query(`SELECT 1 FROM crew_audit WHERE event = 'job-crash-limit'`).all()).toEqual([]);
  });

  test('an existing crew_job gains quit_clean', () => {
    const raw = new Database(':memory:');
    raw.exec(`CREATE TABLE claude_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, config_dir TEXT NOT NULL UNIQUE, email TEXT)`);
    raw.exec(`CREATE TABLE crew_job (id TEXT PRIMARY KEY, hire_id TEXT NOT NULL, epoch INTEGER NOT NULL, scope TEXT NOT NULL, requested_by TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT)`);
    initializeCrewTables(raw as unknown as Db);
    expect(columns(raw, 'crew_job')).toContain('quit_clean');
  });

  test('a job left running while it waits on a card still parks, whatever its attempts', () => {
    const { raw, db } = crewDb();
    raw.exec(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, state, attempts) VALUES ('j1', 'h', 1, 'owner', 'p', 'running', ${MAX_ATTEMPTS})`);
    raw.exec(`INSERT INTO crew_card (raise_id, job_id, hire_id, thread_key, scope, requested_by, kind, state) VALUES ('c1', 'j1', 'h', 'chat:owner', 'owner', 'p', 'permission', 'waiting')`);
    initializeCrewTables(db);
    expect(raw.query(`SELECT state FROM crew_job WHERE id = 'j1'`).get()).toEqual({ state: 'parked' });
  });

  test('database.ts calls the crew initializer', async () => {
    const source = await Bun.file(new URL('../../database.ts', import.meta.url)).text();
    expect(source).toContain('initializeCrewTables(db)');
    expect(CREW_TABLES_SQL).toContain('crew_outbox_local');
  });
});
