/**
 * Crew's local tables. The `*_cache` tables mirror what the Hub syncs; the
 * rest exist only on this machine. Kept apart from database.ts so a test can
 * execute the shipped SQL without importing that module.
 */
import type Database from 'better-sqlite3';

export const CREW_JOB_STATES = ['queued', 'running', 'parked', 'done', 'dead', 'dropped'] as const;
export type CrewJobState = (typeof CREW_JOB_STATES)[number];

export const CREW_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS crew_hire_cache (
      hire_id TEXT PRIMARY KEY,
      rev INTEGER NOT NULL DEFAULT 0,
      home_machine_id TEXT DEFAULT NULL,
      epoch INTEGER NOT NULL DEFAULT 0,
      state TEXT DEFAULT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS crew_role_cache (
      role_id TEXT PRIMARY KEY,
      rev INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS crew_skill_cache (
      skill_id TEXT PRIMARY KEY,
      rev INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS crew_routine_cache (
      routine_id TEXT PRIMARY KEY,
      hire_id TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      last_fired TEXT DEFAULT NULL,
      data TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS crew_note (
      note_id TEXT PRIMARY KEY,
      hire_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('owner', 'shared')),
      path TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- id is the Hub's inbound id for a delivered message, so a re-delivery is ignored.
    CREATE TABLE IF NOT EXISTS crew_job (
      id TEXT PRIMARY KEY,
      hire_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'routine', 'card')),
      epoch INTEGER NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('owner', 'circle')),
      requested_by TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'running', 'parked', 'done', 'dead', 'dropped')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_crew_job_hire_state ON crew_job(hire_id, state);

    CREATE TABLE IF NOT EXISTS crew_run (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      hire_id TEXT NOT NULL,
      thread_key TEXT DEFAULT NULL,
      account_id TEXT DEFAULT NULL,
      session_id TEXT DEFAULT NULL,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT DEFAULT NULL,
      outcome TEXT DEFAULT NULL,
      reply_text TEXT DEFAULT NULL,
      rate_limit TEXT DEFAULT NULL,
      usage TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS crew_thread (
      hire_id TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      session_id TEXT DEFAULT NULL,
      account_id TEXT DEFAULT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (hire_id, thread_key)
    );

    CREATE TABLE IF NOT EXISTS crew_taint (
      hire_id TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      source TEXT NOT NULL,
      tainted_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (hire_id, thread_key)
    );

    CREATE TABLE IF NOT EXISTS crew_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hire_id TEXT DEFAULT NULL,
      event TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- seq is the send order. Each row keeps the frame type and protocol version
    -- it was written under, so an upgrade can drop what it no longer speaks.
    CREATE TABLE IF NOT EXISTS crew_outbox_local (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      hire_id TEXT DEFAULT NULL,
      epoch INTEGER DEFAULT NULL,
      job_id TEXT DEFAULT NULL,
      frame_type TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      body TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'parked', 'unsendable')),
      unanswered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- A card this machine raised. A decision after the run parked resumes as decision_job_id.
    CREATE TABLE IF NOT EXISTS crew_card (
      raise_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      hire_id TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('owner', 'circle')),
      requested_by TEXT NOT NULL,
      kind TEXT NOT NULL,
      tool TEXT DEFAULT NULL,
      input_hash TEXT DEFAULT NULL,
      state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'parked', 'decided', 'used')),
      decision TEXT DEFAULT NULL,
      decision_job_id TEXT DEFAULT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS crew_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
`;

export function initializeCrewTables(database: Database.Database): void {
  database.exec(CREW_TABLES_SQL);

  const addColumn = (table: string, column: string, ddl: string): void => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((col) => col.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };

  // The Crew token lives on the account row; NULL reads as "no token".
  addColumn('claude_accounts', 'crew_token_enc', 'crew_token_enc TEXT DEFAULT NULL');
  addColumn('claude_accounts', 'crew_token_created_at', 'crew_token_created_at TEXT DEFAULT NULL');
  addColumn('claude_accounts', 'crew_token_expires_at', 'crew_token_expires_at TEXT DEFAULT NULL');
  addColumn('claude_accounts', 'crew_signed_in_at', 'crew_signed_in_at TEXT DEFAULT NULL');
  addColumn('claude_accounts', 'crew_auth_failed_at', 'crew_auth_failed_at TEXT DEFAULT NULL');
  addColumn('claude_accounts', 'crew_reminded', 'crew_reminded TEXT DEFAULT NULL');

  // A job left running by a quit or crash was interrupted, so it gets its attempt back and runs again once a lease is renewed.
  database
    .prepare(`UPDATE crew_job SET state = 'queued', attempts = MAX(attempts - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE state = 'running'`)
    .run();
}
