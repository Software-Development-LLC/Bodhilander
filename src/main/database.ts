import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';

let db: Database.Database | null = null;
let sqliteVecAvailable = false;

export function isSqliteVecAvailable(): boolean {
  return sqliteVecAvailable;
}

export function getDatabase(): Database.Database {
  if (db) return db;

  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'bodhilander.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Try to load sqlite-vec extension for vector search (optional)
  try {
    if (app.isPackaged) {
      // In packaged builds, sqlite-vec's index.cjs resolves the DLL using __dirname
      // which points inside the asar archive. But the native binary is in app.asar.unpacked.
      // We must manually resolve the path to the unpacked extension.
      const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
      const arch = process.arch;
      const packageName = `sqlite-vec-${platform}-${arch}`;
      const vecPath = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        packageName,
        'vec0'
      );
      log.info('Loading sqlite-vec from unpacked path:', vecPath);
      db.loadExtension(vecPath);
    } else {
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(db);
    }
    sqliteVecAvailable = true;
    log.info('sqlite-vec extension loaded successfully');
  } catch (e) {
    log.warn('sqlite-vec extension not available — vector code search will be disabled:', (e as Error).message);
  }

  initializeTables(db);
  initializeCodeSearchTables(db);

  return db;
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

function initializeCodeSearchTables(database: Database.Database): void {
  // Code indexes table
  database.exec(`
    CREATE TABLE IF NOT EXISTS code_indexes (
      id TEXT PRIMARY KEY,
      directory_path TEXT UNIQUE NOT NULL,
      last_indexed_at TEXT,
      status TEXT CHECK(status IN ('pending', 'indexing', 'ready', 'error', 'stale')) DEFAULT 'pending',
      file_count INTEGER DEFAULT 0,
      chunk_count INTEGER DEFAULT 0,
      model_name TEXT DEFAULT 'bge-base-en-v1.5',
      embedding_dimensions INTEGER DEFAULT 768,
      error_message TEXT
    )
  `);

  // Indexed files table
  database.exec(`
    CREATE TABLE IF NOT EXISTS indexed_files (
      id TEXT PRIMARY KEY,
      index_id TEXT NOT NULL REFERENCES code_indexes(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      file_hash TEXT,
      chunk_count INTEGER DEFAULT 0,
      UNIQUE(index_id, file_path)
    )
  `);

  // Code chunks table
  database.exec(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      id TEXT PRIMARY KEY,
      index_id TEXT NOT NULL REFERENCES code_indexes(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      chunk_type TEXT,
      embedding BLOB,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Symbols table
  database.exec(`
    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT PRIMARY KEY,
      index_id TEXT NOT NULL REFERENCES code_indexes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      symbol_type TEXT CHECK(symbol_type IN ('function', 'class', 'method', 'variable', 'interface', 'type')),
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      "column" INTEGER NOT NULL,
      parent_symbol_id TEXT REFERENCES symbols(id),
      signature TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Indexes for fast lookups
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_index_id ON code_chunks(index_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON code_chunks(file_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_index_file ON code_chunks(index_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_symbols_index_id ON symbols(index_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
    CREATE INDEX IF NOT EXISTS idx_files_index_id ON indexed_files(index_id);
    CREATE INDEX IF NOT EXISTS idx_files_mtime ON indexed_files(mtime);
  `);

  // Vector table for similarity search (768 dimensions for bge-base-en-v1.5)
  // Only create if sqlite-vec extension is available
  if (!sqliteVecAvailable) {
    log.info('Skipping vector table setup — sqlite-vec not available');
    return;
  }

  try {
    // Check if we need to migrate from old 384-dimension table
    const tableExists = database.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='code_chunks_vec'
    `).get();

    if (tableExists) {
      // Try a test insert with 768 dimensions to see if it fails
      // If it does, we need to recreate the table
      try {
        const testEmbedding = Buffer.from(new Float32Array(768).buffer);
        database.prepare(`INSERT INTO code_chunks_vec (chunk_id, embedding) VALUES ('__dimension_test__', ?)`).run(testEmbedding);
        // Clean up test row
        database.prepare(`DELETE FROM code_chunks_vec WHERE chunk_id = '__dimension_test__'`).run();
        log.info('Vector table already has correct dimensions (768)');
      } catch (dimError: any) {
        if (dimError.message && dimError.message.includes('Dimension mismatch')) {
          log.info('Migrating vector table from 384 to 768 dimensions...');
          database.exec('DROP TABLE code_chunks_vec');
          database.exec(`
            CREATE VIRTUAL TABLE code_chunks_vec USING vec0(
              chunk_id TEXT PRIMARY KEY,
              embedding FLOAT[768]
            )
          `);
          log.info('Vector table migrated successfully');
        } else {
          throw dimError;
        }
      }
    } else {
      database.exec(`
        CREATE VIRTUAL TABLE code_chunks_vec USING vec0(
          chunk_id TEXT PRIMARY KEY,
          embedding FLOAT[768]
        )
      `);
      log.info('Vector table created with 768 dimensions');
    }
  } catch (e) {
    log.error('Vector table setup error:', e);
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
