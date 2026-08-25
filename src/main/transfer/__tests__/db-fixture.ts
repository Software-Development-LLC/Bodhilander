/**
 * Post-migration schema and seed helpers for the transfer-bundle tests.
 * bun:sqlite stands in for better-sqlite3 — same API for these statements,
 * and no native build needed.
 */
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';

export const SCHEMA = `
  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#888888',
    working_dir TEXT DEFAULT '',
    "order" INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    parent_id TEXT DEFAULT NULL,
    collapsed INTEGER DEFAULT 0,
    claude_account_id TEXT DEFAULT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    working_dir TEXT NOT NULL,
    state TEXT DEFAULT 'idle',
    shell_type TEXT DEFAULT 'bash',
    "order" INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_activity_at TEXT DEFAULT CURRENT_TIMESTAMP,
    claude_session_id TEXT DEFAULT NULL,
    ended_at TEXT DEFAULT NULL,
    duration_seconds REAL DEFAULT 0,
    claude_account_id TEXT DEFAULT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    failover_from_account_id TEXT DEFAULT NULL,
    failover_prev_account_id TEXT DEFAULT NULL
  );

  CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE claude_accounts (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    config_dir TEXT NOT NULL UNIQUE,
    email TEXT,
    color TEXT DEFAULT '#888888',
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT
  );
  CREATE UNIQUE INDEX idx_claude_accounts_single_default
    ON claude_accounts(is_default) WHERE is_default = 1;

  CREATE TABLE session_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK(event_type IN (
      'session_start', 'session_stop', 'state_change', 'tool_use', 'turn_complete', 'error', 'notification'
    )),
    event_data TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE chat_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE arena_runs (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    working_dir TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE arena_responses (
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
    error TEXT DEFAULT NULL,
    round INTEGER NOT NULL DEFAULT 0,
    prompt TEXT DEFAULT NULL,
    session_ref TEXT DEFAULT NULL
  );

  CREATE TABLE relay_grants (
    id TEXT PRIMARY KEY,
    relay_origin TEXT NOT NULL,
    grantee_user_id TEXT NOT NULL,
    grantee_login TEXT,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    bound_at INTEGER,
    expires_at INTEGER,
    revoked_at INTEGER,
    revoke_pending INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE relay_grant_sessions (
    grant_id TEXT NOT NULL REFERENCES relay_grants(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    pty_epoch INTEGER NOT NULL,
    PRIMARY KEY(grant_id, session_id)
  );

  CREATE TABLE relay_share_invites (
    invite_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    pty_epoch INTEGER NOT NULL,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

export function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export interface SeedOptions {
  /** Working directories the seeded sessions run in. */
  workingDirs?: string[];
  accountConfigDir?: string;
}

/** A source machine with one account, one group, and one session per dir. */
export function seedSourceDb(db: Database, options: SeedOptions = {}): void {
  const dirs = options.workingDirs ?? ['/Users/will/Work/Repos/Bodhilander'];
  const configDir = options.accountConfigDir ?? '/src/userData/claude-accounts/acct-1/.claude';

  db.prepare(
    `INSERT INTO claude_accounts (id, label, config_dir, email, color, is_default, created_at, last_used_at)
     VALUES ('acct-1', 'Work', ?, 'will@example.com', '#61afef', 1, '2026-01-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  ).run(configDir);

  db.prepare(
    `INSERT INTO groups (id, name, color, working_dir, "order", created_at, parent_id, collapsed, claude_account_id)
     VALUES ('g1', 'Repos', '#98c379', ?, 0, '2026-01-02T00:00:00.000Z', NULL, 0, 'acct-1')`,
  ).run(dirs[0]);

  dirs.forEach((dir, i) => {
    db.prepare(
      `INSERT INTO sessions (id, group_id, name, working_dir, state, shell_type, "order", created_at,
                             last_activity_at, claude_session_id, ended_at, duration_seconds, claude_account_id, provider)
       VALUES (?, 'g1', ?, ?, 'idle', 'claude', ?, '2026-01-03T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
               ?, NULL, 12.5, 'acct-1', 'claude')`,
    ).run(`s${i + 1}`, `Session ${i + 1}`, dir, i, `conv-${i + 1}`);

    db.prepare(
      `INSERT INTO session_events (id, session_id, event_type, event_data, created_at)
       VALUES (?, ?, 'session_start', '{}', '2026-01-03T00:00:01.000Z')`,
    ).run(`ev${i + 1}`, `s${i + 1}`);

    db.prepare(
      `INSERT INTO chat_events (id, session_id, type, payload, timestamp)
       VALUES (?, ?, 'assistant_text', '{"text":"hello"}', 1756080000000)`,
    ).run(`ce${i + 1}`, `s${i + 1}`);
  });

  db.exec(`
    INSERT INTO arena_runs (id, prompt, working_dir, created_at)
      VALUES ('run1', 'compare these', '/Users/will/Work/Repos', '2026-02-01T00:00:00.000Z');
    INSERT INTO arena_responses (id, run_id, provider, status, response_text, round)
      VALUES ('resp1', 'run1', 'claude', 'done', 'an answer', 0);
  `);
}

/** The secrets and machine-local rows an export must leave behind. */
export const SECRET_VALUES = {
  providerApiKey: 'SEALED-PROVIDER-KEY-DO-NOT-EXPORT',
  teamsTokens: 'SEALED-TEAMS-TOKEN-DO-NOT-EXPORT',
  relayPrivateKey: 'SEALED-RELAY-PRIVATE-KEY-DO-NOT-EXPORT',
  pushEndpoint: 'https://push.example.invalid/SEALED-PUSH-ENDPOINT',
  grantCertificate: 'SEALED-GRANT-CERTIFICATE',
  windowBounds: '{"x":11,"y":22,"width":33,"height":44}',
  customShellPath: '/opt/SEALED-CUSTOM-SHELL/bash',
  preferredEditor: 'SEALED-EDITOR',
  soundPath: '/Users/will/SEALED-SOUND.wav',
};

export function seedSecrets(db: Database): void {
  const pref = db.prepare('INSERT INTO preferences (key, value) VALUES (?, ?)');
  pref.run('providerApiKey.anthropic', SECRET_VALUES.providerApiKey);
  pref.run('providerApiKeyUse.anthropic', 'true');
  pref.run('teamsTokens', SECRET_VALUES.teamsTokens);
  pref.run('relay.ed25519Priv', SECRET_VALUES.relayPrivateKey);
  pref.run('relay.machineId', 'machine-abc');
  pref.run('windowBounds', SECRET_VALUES.windowBounds);
  pref.run('customShellPath', SECRET_VALUES.customShellPath);
  pref.run('preferredEditor', SECRET_VALUES.preferredEditor);
  pref.run('soundWaitingCustomPath', SECRET_VALUES.soundPath);
  pref.run('theme', 'dark');
  pref.run('closeToTray', 'true');

  db.prepare(
    `INSERT INTO push_subscriptions (id, device_id, endpoint, p256dh, auth, created_at)
     VALUES ('push1', 'dev1', ?, 'p256', 'auth', 1756080000000)`,
  ).run(SECRET_VALUES.pushEndpoint);

  db.prepare(
    `INSERT INTO relay_grants (id, relay_origin, grantee_user_id, grantee_login, role, status, created_at)
     VALUES ('grant1', ?, 'user-9', 'someone', 'viewer', 'active', 1756080000000)`,
  ).run(SECRET_VALUES.grantCertificate);
  db.prepare(
    `INSERT INTO relay_grant_sessions (grant_id, session_id, pty_epoch) VALUES ('grant1', 's1', 1)`,
  ).run();
}

/** Write a transcript where Claude Code would have left it. */
export function writeTranscript(configDir: string, slug: string, uuid: string, body: string): string {
  const dir = path.join(configDir, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}
