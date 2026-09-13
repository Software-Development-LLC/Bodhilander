/**
 * The run engine's tables (CO-722).
 *
 * Separate from `database.ts` so a test can build the real schema without
 * importing that module, which repository tests mock wholesale. A fixture
 * that re-declares these tables by hand is a fixture that can drift: a column
 * added here and missed there produces tests passing against a schema nobody
 * ships.
 */
export const RUN_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      -- The tracking key (BWA-4764), never the folder name: verify-merge-order
      -- searches PR titles for it with in:title, and no PR title carries the
      -- descriptive suffix.
      initiative_key TEXT NOT NULL,
      initiative_dir TEXT NOT NULL,
      -- The plugin copy this run is pinned to, passed as --plugin-dir. Three
      -- copies were reachable in one 18-hour window and they need not agree.
      harness_path TEXT NOT NULL,
      bodhi_root TEXT NOT NULL,
      -- Resolved interpreter. A bare python3 is not a name to trust: on
      -- Windows it can be a Store alias that is not Python at all.
      python_path TEXT DEFAULT NULL,
      state TEXT NOT NULL DEFAULT 'preparing',
      permission_posture TEXT NOT NULL DEFAULT 'manual',
      budget_usd REAL DEFAULT NULL,
      group_id TEXT DEFAULT NULL REFERENCES groups(id) ON DELETE SET NULL,
      blocked_reason TEXT DEFAULT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS run_owners (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      -- Mirrored from team.yaml's owners block, which spawn.sh owns. Never
      -- authored here.
      worktree TEXT NOT NULL,
      branch TEXT NOT NULL,
      base TEXT NOT NULL,
      scratch TEXT DEFAULT NULL,
      -- The role that runs gate 2 here. Recorded because where several
      -- agents declare the repo, a PERSON chose between them, and a choice
      -- that does not survive the process is one gate 2 has to ask again.
      agent TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      pr_number INTEGER DEFAULT NULL,
      pr_url TEXT DEFAULT NULL,
      PRIMARY KEY (run_id, repo)
    );

    CREATE TABLE IF NOT EXISTS run_gates (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      gate INTEGER NOT NULL,
      agent TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      -- The short id 'claude --bg' prints, which attach/logs/stop take.
      bg_session_id TEXT DEFAULT NULL,
      claude_session_id TEXT DEFAULT NULL,
      account_id TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      verdict_json TEXT DEFAULT NULL,
      receipt_path TEXT DEFAULT NULL,
      tokens_in INTEGER DEFAULT NULL,
      tokens_out INTEGER DEFAULT NULL,
      cost_usd REAL DEFAULT NULL,
      -- Per gate, not per run: if you cannot tell afterwards whether an owner
      -- ran unsandboxed, you cannot trust what it produced.
      posture TEXT NOT NULL DEFAULT 'manual',
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT DEFAULT NULL
    );

    -- Append-only. This one table is the run view, the audit trail and resume.
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      at TEXT DEFAULT CURRENT_TIMESTAMP,
      kind TEXT NOT NULL,
      gate INTEGER DEFAULT NULL,
      repo TEXT DEFAULT NULL,
      payload_json TEXT DEFAULT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_run_gates_run ON run_gates(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
  `;
