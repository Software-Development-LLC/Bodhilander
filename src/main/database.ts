import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';

let db: Database.Database | null = null;
export function getDatabase(): Database.Database {
  if (db) return db;

  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'bodhilander.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initializeTables(db);
  initializeArenaTables(db);

  // One-time reclaim for the removed code-indexing feature (see below).
  if (dropLegacyCodeSearchTables(db)) {
    try {
      db.exec('VACUUM');
      log.info('[DB] VACUUM complete — reclaimed code-index disk space');
    } catch (e) {
      // Space stays allocated until a later VACUUM; the data is already gone.
      log.warn('[DB] VACUUM after code-index cleanup failed:', (e as Error).message);
    }
  }

  return db;
}

/** Tables created by the removed code-indexing feature. */
const LEGACY_CODE_SEARCH_TABLES = ['code_chunks', 'symbols', 'indexed_files', 'code_indexes'] as const;

/**
 * Drop the leftover tables from the removed code-indexing / semantic-search
 * feature. Nothing reads them anymore and they can be very large (chunk source
 * text plus 768-dimension embeddings), so we reclaim the space on first launch
 * after upgrading.
 *
 * Deliberately best-effort and non-fatal: this runs against the database holding
 * the user's real data (sessions, groups, memories), so every step is guarded and
 * a failure only logs rather than aborting startup or leaving things half-done.
 *
 * @returns true if anything was found to clean up (so the caller can VACUUM).
 */
export function dropLegacyCodeSearchTables(database: Database.Database): boolean {
  let present: string[];
  try {
    present = (
      database
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND (name IN ('code_chunks','symbols','indexed_files','code_indexes')
                   OR name LIKE 'code_chunks_vec%')`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
  } catch (e) {
    log.warn('[DB] could not check for legacy code-search tables:', (e as Error).message);
    return false;
  }
  if (present.length === 0) return false;

  log.info('[DB] Removing legacy code-search tables:', present.join(', '));

  // Plain tables first — dropping them also drops their indexes. Child tables
  // before code_indexes so the FK references go away cleanly.
  for (const table of LEGACY_CODE_SEARCH_TABLES) {
    try {
      database.exec(`DROP TABLE IF EXISTS ${table}`);
    } catch (e) {
      log.warn(`[DB] could not drop ${table}:`, (e as Error).message);
    }
  }

  // code_chunks_vec is a vec0 VIRTUAL table. sqlite-vec is no longer bundled, so
  // a normal DROP raises "no such module: vec0". Fall back to dropping its shadow
  // tables directly — that's where the embedding data actually lives, so this is
  // what reclaims the space. Any leftover schema entry is inert (nothing queries
  // it), and we do NOT edit sqlite_master: not worth risking real user data.
  if (present.includes('code_chunks_vec')) {
    try {
      database.exec('DROP TABLE IF EXISTS code_chunks_vec');
    } catch {
      for (const shadow of present.filter((n) => n.startsWith('code_chunks_vec_'))) {
        try {
          database.exec(`DROP TABLE IF EXISTS "${shadow}"`);
        } catch (e) {
          log.warn(`[DB] could not drop shadow table ${shadow}:`, (e as Error).message);
        }
      }
    }
  }

  return true;
}

function initializeTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#888888',
      working_dir TEXT DEFAULT '',
      "order" INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      state TEXT DEFAULT 'idle',
      shell_type TEXT DEFAULT 'bash',
      "order" INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_activity_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS claude_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      config_dir TEXT NOT NULL UNIQUE,
      email TEXT,
      color TEXT DEFAULT '#888888',
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_accounts_single_default
      ON claude_accounts(is_default) WHERE is_default = 1;
  `);

  // Migration: Add working_dir column to groups if it doesn't exist
  const columns = database.prepare("PRAGMA table_info(groups)").all() as { name: string }[];
  if (!columns.some(col => col.name === 'working_dir')) {
    database.exec("ALTER TABLE groups ADD COLUMN working_dir TEXT DEFAULT ''");
  }

  // Migration: Add parent_id column to groups if it doesn't exist
  if (!columns.some(col => col.name === 'parent_id')) {
    database.exec("ALTER TABLE groups ADD COLUMN parent_id TEXT DEFAULT NULL");
  }

  // Migration: Add collapsed column to groups if it doesn't exist
  if (!columns.some(col => col.name === 'collapsed')) {
    database.exec("ALTER TABLE groups ADD COLUMN collapsed INTEGER DEFAULT 0");
  }

  // Migration: Add claude_session_id column to sessions if it doesn't exist (BDHLNDR-9)
  // Stores the Claude Code session UUID so we can resume conversation on restart.
  const sessionColumns = database.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessionColumns.some(col => col.name === 'claude_session_id')) {
    database.exec("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT DEFAULT NULL");
  }

  // Migration: Add ended_at and duration_seconds columns to sessions (BDHLNDR-17)
  const sessionColsBdhlndr17 = sessionColumns.map(c => c.name);
  let durationColumnJustAdded = false;
  if (!sessionColsBdhlndr17.includes('ended_at')) {
    database.exec("ALTER TABLE sessions ADD COLUMN ended_at TEXT DEFAULT NULL");
  }
  if (!sessionColsBdhlndr17.includes('duration_seconds')) {
    database.exec("ALTER TABLE sessions ADD COLUMN duration_seconds REAL DEFAULT 0");
    durationColumnJustAdded = true;
  }

  // Migration: Add claude_account_id column to groups and sessions (BDHLNDR-31).
  // Multi-account support — session inherits from group if session's own column
  // is NULL; group falls back to the default account, then to legacy ~/.claude.
  // ON DELETE SET NULL is enforced in the repositories/app layer (SQLite doesn't
  // support adding FK constraints via ALTER TABLE); deleteAccount() in the
  // accounts repo explicitly nulls referring rows before removing the account.
  if (!columns.some(col => col.name === 'claude_account_id')) {
    database.exec("ALTER TABLE groups ADD COLUMN claude_account_id TEXT DEFAULT NULL");
  }
  if (!sessionColsBdhlndr17.includes('claude_account_id')) {
    database.exec("ALTER TABLE sessions ADD COLUMN claude_account_id TEXT DEFAULT NULL");
  }

  // Migration: Add provider column to sessions (#96, epic #94).
  // Which agent provider the session runs (providers registry id). Existing
  // rows are Claude sessions by definition, so they default to 'claude'.
  if (!sessionColsBdhlndr17.includes('provider')) {
    database.exec("ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
  }

  // Migration: Create session_events table (BDHLNDR-17)
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'session_start', 'session_stop', 'state_change', 'tool_use', 'turn_complete', 'error', 'notification'
      )),
      event_data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_session_events_session_type_time ON session_events(session_id, event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_events(created_at);
  `);

  // Backfill duration_seconds for existing stopped sessions (one-time, rough wall-clock estimate)
  if (durationColumnJustAdded) {
    database.exec(`
      UPDATE sessions
      SET duration_seconds = (julianday(last_activity_at) - julianday(created_at)) * 86400
      WHERE duration_seconds = 0 AND state = 'stopped'
        AND last_activity_at IS NOT NULL AND created_at IS NOT NULL
    `);
  }

  // Migration: Create chat_events table (BDHLNDR-51).
  // Stores parsed chat-shaped events extracted from the PTY data stream — the
  // server-side foundation for the mobile-companion PWA chat view (BDHLNDR-56)
  // and the chat-events REST snapshot (BDHLNDR-58). The terminal:output WS
  // stream is unchanged; chat:event is an additive, parallel channel.
  //
  // Payload is JSON whose shape is determined by `type` (see chat-parser/types.ts):
  //   assistant_text  → { text }
  //   tool_call       → { tool, argsBrief }
  //   error           → { text }
  //   prompt_yes_no   → { question }
  //   prompt_options  → { question, options: [{ key, label }] }
  //   response        → { text }
  //
  // timestamp is ms since epoch (matches the WS message timestamp field).
  // Per-session pruning to 1000 most-recent rows happens inside the repo on
  // each insert — keeps storage bounded without a background sweep.
  database.exec(`
    CREATE TABLE IF NOT EXISTS chat_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_events_session_ts ON chat_events(session_id, timestamp);
  `);

  // Migration: Create push_subscriptions table (BDHLNDR-49).
  // Stores Web Push (VAPID) subscriptions registered by paired mobile
  // companions so the desktop can dispatch attention notifications even
  // when the PWA isn't open. `endpoint` is the browser-issued URL the push
  // service listens on — it's globally unique per subscription, so we use
  // it as the natural-key for upsert / dead-subscription cleanup. p256dh
  // and auth are the subscription's encryption material (URL-base64). No FK
  // to paired_devices because we want to ON-DELETE cascade these manually
  // through the repo, and SQLite can't ALTER TABLE to add FKs after the
  // fact; the deletion path in pairing-manager unpair() can call into the
  // repo to clean up.
  database.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_device ON push_subscriptions(device_id);
  `);

  // Migration: Create memories table if it doesn't exist
  database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('decision', 'error_fix', 'pattern', 'context', 'note')),
      content TEXT NOT NULL,
      source TEXT DEFAULT 'auto' CHECK(source IN ('auto', 'manual', 'claude')),
      tags TEXT,
      pinned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
    CREATE INDEX IF NOT EXISTS idx_memories_group ON memories(group_id);
    CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned) WHERE pinned = 1;
  `);

  // Create FTS5 virtual table for full-text search if it doesn't exist
  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content=memories,
        content_rowid=rowid
      );
    `);

    // Create triggers to keep FTS in sync
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
        INSERT INTO memories_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;
    `);
  } catch (e) {
    // FTS5 triggers might already exist, ignore errors
    console.log('FTS5 setup (may already exist):', e);
  }

  // Ensure __global__ group exists for global context memories (BDHLNDR-35).
  // This row is required by the memory system (memories with group_id =
  // '__global__' inject into every session as global context) but is hidden
  // from the sidebar UI — see the store filter in src/renderer/store/groups.ts.
  // Note: we no longer seed a visible "Default" group on first run. Users
  // create their own groups; existing installs keep whatever's already there.
  const globalGroup = database.prepare('SELECT id FROM groups WHERE id = ?').get('__global__');
  if (!globalGroup) {
    database.prepare(`
      INSERT INTO groups (id, name, color, working_dir, "order")
      VALUES ('__global__', 'Global Context', '#61afef', '', -1)
    `).run();
  }
}

// Arena mode tables (#100, epic #94). One run = one prompt fanned out to N
// contestants; responses persist final text + metrics.
function initializeArenaTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS arena_runs (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      working_dir TEXT DEFAULT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS arena_responses (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES arena_runs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      response_text TEXT NOT NULL DEFAULT '',
      ttft_ms INTEGER DEFAULT NULL,
      total_ms INTEGER DEFAULT NULL,
      input_tokens INTEGER DEFAULT NULL,
      output_tokens INTEGER DEFAULT NULL,
      cost_usd REAL DEFAULT NULL,
      error TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_arena_responses_run ON arena_responses(run_id);
  `);

  // Migration: scope a run to a project folder (group working dir) so
  // contestant CLIs answer with that codebase as context. NULL = unscoped.
  const runColumns = database.prepare('PRAGMA table_info(arena_runs)').all() as { name: string }[];
  if (!runColumns.some((col) => col.name === 'working_dir')) {
    database.exec('ALTER TABLE arena_runs ADD COLUMN working_dir TEXT DEFAULT NULL');
  }

  // Migration: follow-up rounds. round 0 = the run's initial prompt; later
  // rounds carry their own prompt. session_ref stores the CLI session/thread
  // id the response can be resumed from (NULL = column can't continue).
  const responseColumns = database.prepare('PRAGMA table_info(arena_responses)').all() as { name: string }[];
  if (!responseColumns.some((col) => col.name === 'round')) {
    database.exec('ALTER TABLE arena_responses ADD COLUMN round INTEGER NOT NULL DEFAULT 0');
    database.exec('ALTER TABLE arena_responses ADD COLUMN prompt TEXT DEFAULT NULL');
    database.exec('ALTER TABLE arena_responses ADD COLUMN session_ref TEXT DEFAULT NULL');
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
