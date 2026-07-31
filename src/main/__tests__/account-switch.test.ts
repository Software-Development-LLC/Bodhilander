/**
 * Account-switch tests (BDHLNDR-31) — reassigning a session or group's Claude
 * account has to report which ptys need respawning (CLAUDE_CONFIG_DIR is fixed
 * at spawn time) and carry the in-flight conversation transcript into the new
 * account's config dir so the respawn can still --resume it.
 *
 * Uses bun:sqlite (API-compatible with better-sqlite3 for the statements the
 * repos issue) so no native build is required to run the suite.
 *
 * Run with: bun test src/main/__tests__
 */
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let db: Database;

mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
}));

mock.module('../database', () => ({
  getDatabase: () => db,
}));

const accountSwitch = await import('../account-switch');

let tmp: string;

function freshDb(): Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      working_dir TEXT,
      state TEXT,
      shell_type TEXT DEFAULT 'bash',
      "order" INTEGER DEFAULT 0,
      created_at TEXT,
      last_activity_at TEXT,
      claude_session_id TEXT DEFAULT NULL,
      ended_at TEXT DEFAULT NULL,
      duration_seconds REAL DEFAULT 0,
      claude_account_id TEXT DEFAULT NULL,
      provider TEXT NOT NULL DEFAULT 'claude'
    );
    CREATE TABLE groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      working_dir TEXT,
      "order" INTEGER DEFAULT 0,
      created_at TEXT,
      parent_id TEXT DEFAULT NULL,
      collapsed INTEGER DEFAULT 0,
      claude_account_id TEXT DEFAULT NULL
    );
    CREATE TABLE claude_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      config_dir TEXT NOT NULL,
      email TEXT,
      color TEXT,
      is_default INTEGER DEFAULT 0,
      created_at TEXT,
      last_used_at TEXT
    );
  `);
  return d;
}

/** Register an account backed by a real (empty) config dir under tmp. */
function addAccount(id: string, isDefault = false): string {
  const configDir = path.join(tmp, id, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  db.prepare(`
    INSERT INTO claude_accounts (id, label, config_dir, email, color, is_default, created_at, last_used_at)
    VALUES (?, ?, ?, NULL, '#888888', ?, '2026-07-31T00:00:00Z', NULL)
  `).run(id, id, configDir, isDefault ? 1 : 0);
  return configDir;
}

function addGroup(id: string, accountId: string | null = null): void {
  db.prepare(`
    INSERT INTO groups (id, name, color, working_dir, "order", created_at, parent_id, collapsed, claude_account_id)
    VALUES (?, ?, '#fff', '/tmp', 0, '2026-07-31T00:00:00Z', NULL, 0, ?)
  `).run(id, id, accountId);
}

function addSession(
  id: string,
  groupId: string,
  opts: { accountId?: string | null; claudeSessionId?: string | null } = {},
): void {
  db.prepare(`
    INSERT INTO sessions (id, group_id, name, working_dir, state, shell_type, "order",
                          created_at, last_activity_at, claude_session_id, claude_account_id, provider)
    VALUES (?, ?, ?, '/tmp', 'idle', 'claude', 0, '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z', ?, ?, 'claude')
  `).run(id, groupId, id, opts.claudeSessionId ?? null, opts.accountId ?? null);
}

function writeTranscript(configDir: string, project: string, uuid: string): string {
  const dir = path.join(configDir, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, '{"type":"conversation"}\n');
  return file;
}

function storedUuid(sessionId: string): string | null {
  const row = db.prepare('SELECT claude_session_id FROM sessions WHERE id = ?').get(sessionId) as
    { claude_session_id: string | null } | undefined;
  return row?.claude_session_id ?? null;
}

function storedAccount(sessionId: string): string | null {
  const row = db.prepare('SELECT claude_account_id FROM sessions WHERE id = ?').get(sessionId) as
    { claude_account_id: string | null } | undefined;
  return row?.claude_account_id ?? null;
}

beforeEach(() => {
  db = freshDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'account-switch-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('assignSessionAccount', () => {
  test('persists the override and reports the session for restart', () => {
    addAccount('acct-a', true);
    addAccount('acct-b');
    addGroup('g1');
    addSession('s1', 'g1');

    const result = accountSwitch.assignSessionAccount('s1', 'acct-b');

    expect(storedAccount('s1')).toBe('acct-b');
    expect(result.affectedSessionIds).toEqual(['s1']);
  });

  test('reports nothing when the effective account is unchanged', () => {
    addAccount('acct-a', true);
    addGroup('g1', 'acct-a');
    addSession('s1', 'g1', { accountId: 'acct-a' });

    // Clearing the override falls back to the group's account — same account,
    // so the live pty is already correct and must not be disturbed.
    const result = accountSwitch.assignSessionAccount('s1', null);

    expect(storedAccount('s1')).toBeNull();
    expect(result.affectedSessionIds).toEqual([]);
  });

  test('carries the conversation transcript into the new config dir', () => {
    const dirA = addAccount('acct-a', true);
    const dirB = addAccount('acct-b');
    addGroup('g1');
    addSession('s1', 'g1', { accountId: 'acct-a', claudeSessionId: 'uuid-1' });
    writeTranscript(dirA, '-Users-x-repo', 'uuid-1');

    accountSwitch.assignSessionAccount('s1', 'acct-b');

    const copied = path.join(dirB, 'projects', '-Users-x-repo', 'uuid-1.jsonl');
    expect(fs.existsSync(copied)).toBe(true);
    expect(fs.readFileSync(copied, 'utf-8')).toContain('conversation');
    // Transcript is readable from the new account, so the resume UUID survives.
    expect(storedUuid('s1')).toBe('uuid-1');
  });

  test('drops the resume UUID when no transcript can be carried over', () => {
    addAccount('acct-a', true);
    addAccount('acct-b');
    addGroup('g1');
    addSession('s1', 'g1', { accountId: 'acct-a', claudeSessionId: 'uuid-missing' });

    accountSwitch.assignSessionAccount('s1', 'acct-b');

    // A stale UUID would burn a doomed --resume on the next spawn.
    expect(storedUuid('s1')).toBeNull();
  });

  test('leaves an existing transcript in the target dir untouched', () => {
    const dirA = addAccount('acct-a', true);
    const dirB = addAccount('acct-b');
    addGroup('g1');
    addSession('s1', 'g1', { accountId: 'acct-a', claudeSessionId: 'uuid-1' });
    writeTranscript(dirA, '-Users-x-repo', 'uuid-1');
    const target = writeTranscript(dirB, '-Users-x-repo', 'uuid-1');
    fs.writeFileSync(target, '{"type":"newer"}\n');

    accountSwitch.assignSessionAccount('s1', 'acct-b');

    expect(fs.readFileSync(target, 'utf-8')).toContain('newer');
    expect(storedUuid('s1')).toBe('uuid-1');
  });
});

describe('assignGroupAccount', () => {
  test('restarts inheriting sessions and leaves overridden ones alone', () => {
    addAccount('acct-a', true);
    addAccount('acct-b');
    addGroup('g1');
    addSession('inherits', 'g1');
    addSession('overrides', 'g1', { accountId: 'acct-a' });
    addSession('elsewhere', 'g2');

    const result = accountSwitch.assignGroupAccount('g1', 'acct-b');

    expect(result.affectedSessionIds).toEqual(['inherits']);
  });

  test('carries transcripts for every inheriting session', () => {
    const dirA = addAccount('acct-a', true);
    const dirB = addAccount('acct-b');
    addGroup('g1');
    addSession('s1', 'g1', { claudeSessionId: 'uuid-1' });
    addSession('s2', 'g1', { claudeSessionId: 'uuid-2' });
    writeTranscript(dirA, '-Users-x-repo', 'uuid-1');
    writeTranscript(dirA, '-Users-x-repo', 'uuid-2');

    accountSwitch.assignGroupAccount('g1', 'acct-b');

    expect(fs.existsSync(path.join(dirB, 'projects', '-Users-x-repo', 'uuid-1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dirB, 'projects', '-Users-x-repo', 'uuid-2.jsonl'))).toBe(true);
    expect(storedUuid('s1')).toBe('uuid-1');
    expect(storedUuid('s2')).toBe('uuid-2');
  });

  test('falling back to the default account is a no-op when it already applies', () => {
    addAccount('acct-a', true);
    addGroup('g1', 'acct-a');
    addSession('s1', 'g1');

    const result = accountSwitch.assignGroupAccount('g1', null);

    expect(result.affectedSessionIds).toEqual([]);
  });
});
