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

  // Reclaim for the removed code-indexing and memory features. Each drop
  // records its own completion marker, so this branch — including the
  // synchronous VACUUM — runs at most ONCE per database (on the first launch
  // after upgrading), never on subsequent startups. Both cleanups run before
  // the check so a single VACUUM covers whatever either of them freed.
  const droppedCodeSearch = dropLegacyCodeSearchTables(db);
  const droppedMemory = dropLegacyMemoryTables(db);
  if (droppedCodeSearch || droppedMemory) {
    try {
      db.exec('VACUUM');
      log.info('[DB] VACUUM complete — reclaimed legacy feature disk space');
    } catch (e) {
      // Space stays allocated until a later VACUUM; the data is already gone.
      log.warn('[DB] VACUUM after legacy cleanup failed:', (e as Error).message);
    }
  }

  return db;
}

/** Tables created by the removed code-indexing feature. */
const LEGACY_CODE_SEARCH_TABLES = ['code_chunks', 'symbols', 'indexed_files', 'code_indexes'] as const;

/**
 * Marker recording that the one-time cleanup has run.
 *
 * This must NOT be re-derived from the schema. `code_chunks_vec` is a vec0
 * VIRTUAL table whose module is no longer bundled, so its sqlite_master row can
 * never be dropped — deriving "is there work left?" from the schema would report
 * work forever and re-run a full VACUUM on every single launch.
 */
const CODE_SEARCH_CLEANUP_PREF = 'legacyCodeSearchCleanupDone';

function cleanupAlreadyRan(database: Database.Database, pref: string): boolean {
  try {
    const row = database
      .prepare('SELECT value FROM preferences WHERE key = ?')
      .get(pref) as { value?: string } | undefined;
    return row?.value === 'true';
  } catch {
    return false; // preferences unavailable — treat as not-yet-run
  }
}

function markCleanupRan(database: Database.Database, pref: string, label: string): void {
  try {
    database
      .prepare('INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)')
      .run(pref, 'true');
  } catch (e) {
    log.warn(`[DB] could not record ${label} cleanup marker:`, (e as Error).message);
  }
}

/**
 * Drop the leftover tables from the removed code-indexing / semantic-search
 * feature. Nothing reads them anymore and they can be very large (chunk source
 * text plus 768-dimension embeddings), so we reclaim the space on first launch
 * after upgrading.
 *
 * Runs at most ONCE per database (guarded by CODE_SEARCH_CLEANUP_PREF), so the
 * caller's VACUUM is a one-time startup cost rather than something that repeats
 * on every launch.
 *
 * Deliberately best-effort and non-fatal: this runs against the database holding
 * the user's real data (sessions, groups), so every step is guarded and a failure
 * only logs rather than aborting startup or leaving things half-done.
 *
 * @returns true if it actually dropped something (so the caller can VACUUM).
 */
export function dropLegacyCodeSearchTables(database: Database.Database): boolean {
  // Converge: once we've run, never do this work (or the VACUUM) again.
  if (cleanupAlreadyRan(database, CODE_SEARCH_CLEANUP_PREF)) return false;

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
  if (present.length === 0) {
    markCleanupRan(database, CODE_SEARCH_CLEANUP_PREF, 'code-search'); // fresh install — nothing to do, ever
    return false;
  }

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
      // The code_chunks_vec sqlite_master row itself stays (no vec0 module to
      // drop it, and editing sqlite_master isn't worth the risk to real user
      // data). It's inert — the marker below is what stops us retrying forever.
    }
  }

  markCleanupRan(database, CODE_SEARCH_CLEANUP_PREF, 'code-search');
  return true;
}

/** FTS5 sync triggers created by the removed memory / context feature. */
const LEGACY_MEMORY_TRIGGERS = ['memories_ai', 'memories_ad', 'memories_au'] as const;

/**
 * Marker recording that the one-time cleanup has run.
 *
 * Same reasoning as CODE_SEARCH_CLEANUP_PREF — it keeps the caller's VACUUM a
 * one-time cost instead of something that repeats on every launch.
 */
const MEMORY_CLEANUP_PREF = 'legacyMemoryCleanupDone';

/**
 * Drop the leftover tables from the removed memory / context feature. Nothing
 * reads them anymore and the FTS5 index keeps a second copy of every memory's
 * text, so we reclaim the space on first launch after upgrading.
 *
 * Runs at most ONCE per database (guarded by MEMORY_CLEANUP_PREF), so the
 * caller's VACUUM is a one-time startup cost rather than something that repeats
 * on every launch.
 *
 * Deliberately best-effort and non-fatal: this runs against the database holding
 * the user's real data (sessions, groups), so every step is guarded and a failure
 * only logs rather than aborting startup or leaving things half-done.
 *
 * @returns true if it actually dropped something (so the caller can VACUUM).
 */
export function dropLegacyMemoryTables(database: Database.Database): boolean {
  // Converge: once we've run, never do this work (or the VACUUM) again.
  if (cleanupAlreadyRan(database, MEMORY_CLEANUP_PREF)) return false;

  let present: string[];
  try {
    present = (
      database
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND (name IN ('memories','memories_fts')
                   OR name LIKE 'memories_fts_%')`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
  } catch (e) {
    log.warn('[DB] could not check for legacy memory tables:', (e as Error).message);
    return false;
  }

  // The '__global__' group was seeded by the same feature, so it counts as work
  // even on a database that never stored a single memory row.
  let sentinelGroup = false;
  try {
    sentinelGroup = database.prepare('SELECT id FROM groups WHERE id = ?').get('__global__') != null;
  } catch (e) {
    log.warn('[DB] could not check for the legacy __global__ group:', (e as Error).message);
  }

  if (present.length === 0 && !sentinelGroup) {
    markCleanupRan(database, MEMORY_CLEANUP_PREF, 'memory'); // fresh install — nothing to do, ever
    return false;
  }

  const removing = sentinelGroup ? [...present, "groups/'__global__'"] : present;
  log.info('[DB] Removing legacy memory tables:', removing.join(', '));

  // Every step below is guarded and only logs on failure — this runs against
  // the database holding the user's real sessions and groups, so a cleanup
  // problem must never abort startup. `failed` tracks whether the pass was
  // actually complete, so a database that was momentarily locked or on a
  // read-only volume gets retried next launch instead of latching the marker
  // and abandoning the leftovers forever. Same policy as
  // cleanupLegacyMcpServer() in mcp-config.ts.
  let failed = 0;

  // Triggers first: they mirror every memories row into memories_fts, so leaving
  // them in place while the tables go away is asking for "no such table" errors
  // mid-cleanup.
  for (const trigger of LEGACY_MEMORY_TRIGGERS) {
    try {
      database.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    } catch (e) {
      failed++;
      log.warn(`[DB] could not drop trigger ${trigger}:`, (e as Error).message);
    }
  }

  // memories_fts is an fts5 virtual table. Unlike vec0, fts5 IS compiled into
  // better-sqlite3, so this DROP succeeds and takes the five shadow tables that
  // hold the index (_data/_idx/_content/_docsize/_config) with it. We sweep up
  // any strays afterwards anyway — a cleanup interrupted on an earlier launch
  // could have left shadow tables behind without their parent.
  try {
    database.exec('DROP TABLE IF EXISTS memories_fts');
  } catch (e) {
    failed++;
    log.warn('[DB] could not drop memories_fts:', (e as Error).message);
  }
  for (const shadow of present.filter((n) => n.startsWith('memories_fts_'))) {
    try {
      database.exec(`DROP TABLE IF EXISTS "${shadow}"`);
    } catch (e) {
      failed++;
      log.warn(`[DB] could not drop shadow table ${shadow}:`, (e as Error).message);
    }
  }

  // Dropping the table also drops its indexes.
  try {
    database.exec('DROP TABLE IF EXISTS memories');
  } catch (e) {
    failed++;
    log.warn('[DB] could not drop memories:', (e as Error).message);
  }

  // Last: the '__global__' sentinel group the feature seeded for global context.
  //
  // NEVER delete this row blindly. `sessions.group_id` REFERENCES groups(id)
  // ON DELETE CASCADE and foreign_keys is ON, so a bare DELETE cascades through
  // the user's sessions — and session_events cascades off those in turn, taking
  // their analytics history with it.
  //
  // That is a live risk, not a theoretical one: the row was seeded as an
  // ordinary group in v2.2.2 with "order" = -1, which put "Global Context" at
  // the very TOP of the sidebar, and the store filter that hides it only landed
  // in v3.2.9. For those releases it was a perfectly normal drop target, so an
  // upgrading install can genuinely have real sessions parked in it.
  //
  // So: only remove the row when it is empty. If it still holds sessions, keep
  // it and give it a name that means something, so those sessions become
  // visible again instead of being destroyed or orphaned. (Reassigning them
  // isn't an option — group_id = NULL hides them just as thoroughly, since the
  // sidebar renders strictly by group.)
  try {
    // Guard the lookup: a database without a sessions table (a bare fixture, or
    // one mid-initialisation) trivially has no sessions to lose, so the row is
    // safe to drop. Letting the missing table throw would skip the delete AND
    // count a failure, leaving the sentinel behind forever.
    const hasSessionsTable =
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
        .get() != null;

    const orphanedSessions = hasSessionsTable
      ? (
          database
            .prepare('SELECT COUNT(*) AS n FROM sessions WHERE group_id = ?')
            .get('__global__') as { n: number }
        ).n
      : 0;

    if (orphanedSessions > 0) {
      database
        .prepare('UPDATE groups SET name = ?, "order" = 0 WHERE id = ?')
        .run('Recovered Sessions', '__global__');
      log.info(
        `[DB] kept the legacy __global__ group as "Recovered Sessions" — it still holds ${orphanedSessions} session(s)`,
      );
    } else {
      database.prepare('DELETE FROM groups WHERE id = ?').run('__global__');
    }
  } catch (e) {
    failed++;
    log.warn('[DB] could not retire the legacy __global__ group:', (e as Error).message);
  }

  // Only latch when the pass was actually complete. Marking done after every
  // step failed would abandon the leftovers permanently while still charging
  // the user a full synchronous VACUUM that reclaimed nothing.
  if (failed === 0) {
    markCleanupRan(database, MEMORY_CLEANUP_PREF, 'memory');
  } else {
    log.warn(`[DB] legacy memory cleanup incomplete (${failed} step(s) failed); will retry next launch`);
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

    -- Session sharing (docs/designs/session-sharing.md §4). Created eagerly
    -- rather than lazily like paired_devices: the relay tunnel consults
    -- relay_grants on every client:open, and a table that only appears once
    -- sharing is first used would make the deny path depend on setup order.
    --
    -- This desktop is the AUTHORITY. The relay stores an opaque certificate
    -- and routes; the session list a grant actually covers exists only here,
    -- and the status column here is what decides revocation — consulted at every open,
    -- not just for live sockets.
    CREATE TABLE IF NOT EXISTS relay_grants (
      id TEXT PRIMARY KEY,
      -- In the signed byte string and re-checked at dispatch: the relay URL is a
      -- user-settable preference, so a certificate minted against relay A must
      -- not verify on relay B, whose operator controls its own user ids.
      relay_origin TEXT NOT NULL,
      grantee_user_id TEXT NOT NULL,
      grantee_login TEXT,
      role TEXT NOT NULL CHECK(role IN ('viewer','operator')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','revoked')),
      created_at INTEGER NOT NULL,
      bound_at INTEGER,
      expires_at INTEGER,
      revoked_at INTEGER,
      -- Revocation has to survive a disconnected agent: queued here and
      -- flushed to the relay on reconnect.
      revoke_pending INTEGER NOT NULL DEFAULT 0
    );

    -- A grant names sessions explicitly. There is no "share my machine".
    CREATE TABLE IF NOT EXISTS relay_grant_sessions (
      grant_id TEXT NOT NULL REFERENCES relay_grants(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      -- Binds the grant to the PTY INSTANCE, not the session row. sessions.id
      -- survives stop/restart, so without this a share of "Auth refactor"
      -- would follow the row into whatever it becomes weeks later. On restart
      -- the entry goes stale, subscribe is denied, and the owner is re-asked.
      pty_epoch INTEGER NOT NULL,
      PRIMARY KEY(grant_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_relay_grants_status ON relay_grants(status);
    CREATE INDEX IF NOT EXISTS idx_relay_grants_grantee ON relay_grants(grantee_user_id, status);
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

  // Note: we no longer seed a visible "Default" group on first run. Users
  // create their own groups; existing installs keep whatever's already there.
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
