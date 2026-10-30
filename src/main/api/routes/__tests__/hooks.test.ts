/**
 * SessionStart keeps a tab's stored conversation id on the one the CLI runs.
 * Real router, sessions repo and account switch; in-memory bun:sqlite.
 * Run with: bun test --isolate src/main/api/routes/__tests__/hooks.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

let db: Database;
mock.module('../../../database', () => ({
  getDatabase: () => db,
}));
mock.module('electron-log', () => ({
  default: { info() {}, warn() {}, error() {} },
}));
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
}));

const { createHooksRouter } = await import('../hooks');
const accountSwitch = await import('../../../account-switch');

const SPAWNED = '423d1cd2-0000-4000-8000-000000000001';
const RESUMED = '427dee88-0000-4000-8000-000000000002';

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
      provider TEXT NOT NULL DEFAULT 'claude',
      failover_from_account_id TEXT DEFAULT NULL,
      failover_prev_account_id TEXT DEFAULT NULL
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
      claude_account_id TEXT DEFAULT NULL,
      failover_from_account_id TEXT DEFAULT NULL,
      failover_prev_account_id TEXT DEFAULT NULL
    );
    CREATE TABLE claude_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      config_dir TEXT NOT NULL,
      email TEXT,
      color TEXT,
      is_default INTEGER DEFAULT 0,
      created_at TEXT,
      last_used_at TEXT,
      fallback_rank INTEGER DEFAULT NULL,
      limited_until TEXT DEFAULT NULL,
      limited_at TEXT DEFAULT NULL
    );
  `);
  return d;
}

let tmp: string;

function addAccount(id: string, isDefault = false): string {
  const configDir = path.join(tmp, id, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  db.prepare(`
    INSERT INTO claude_accounts (id, label, config_dir, email, color, is_default, created_at, last_used_at)
    VALUES (?, ?, ?, NULL, '#888888', ?, '2026-07-31T00:00:00Z', NULL)
  `).run(id, id, configDir, isDefault ? 1 : 0);
  return configDir;
}

function addSession(id: string, opts: { accountId?: string | null; provider?: string } = {}): void {
  db.prepare(`
    INSERT INTO groups (id, name, color, working_dir, "order", created_at)
    VALUES ('g1', 'g1', '#fff', '/tmp', 0, '2026-07-31T00:00:00Z')
    ON CONFLICT(id) DO NOTHING
  `).run();
  db.prepare(`
    INSERT INTO sessions (id, group_id, name, working_dir, state, shell_type, "order",
                          created_at, last_activity_at, claude_session_id, claude_account_id, provider)
    VALUES (?, 'g1', ?, '/tmp', 'idle', 'claude', 0, '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z', ?, ?, ?)
  `).run(id, id, SPAWNED, opts.accountId ?? null, opts.provider ?? 'claude');
}

function stored(id: string): string | null {
  const row = db.prepare('SELECT claude_session_id FROM sessions WHERE id = ?').get(id) as
    { claude_session_id: string | null } | undefined;
  return row?.claude_session_id ?? null;
}

function writeFile(configDir: string, rel: string, body: string): void {
  const file = path.join(configDir, 'projects', '-Users-x-repo', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

let server: Server;
let baseUrl = '';

beforeAll(() => new Promise<void>((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/hooks', createHooksRouter());
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  });
}));

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  db = freshDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-route-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function sessionStart(body: Record<string, unknown>): Promise<{ updated?: boolean }> {
  const res = await fetch(`${baseUrl}/hooks/session-start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ updated?: boolean }>;
}

describe('POST /hooks/session-start', () => {
  for (const source of ['resume', 'clear', 'compact']) {
    test(`a ${source} moves the tab onto the conversation the CLI reports`, async () => {
      addSession('tab-1');

      const body = await sessionStart({ session_id: 'tab-1', claude_session_id: RESUMED, source });

      expect(body.updated).toBe(true);
      expect(stored('tab-1')).toBe(RESUMED);
    });
  }

  test('a startup is ignored: it is the launch id, or a nested Claude inheriting the tab env', async () => {
    addSession('tab-1');

    const body = await sessionStart({ session_id: 'tab-1', claude_session_id: RESUMED, source: 'startup' });

    expect(body.updated).toBe(false);
    expect(stored('tab-1')).toBe(SPAWNED);
  });

  test('an id that is not path-safe is never stored', async () => {
    addSession('tab-1');

    await sessionStart({ session_id: 'tab-1', claude_session_id: '../../etc/x', source: 'resume' });
    await sessionStart({ session_id: 'tab-1', claude_session_id: 'a b; rm -rf ~', source: 'resume' });

    expect(stored('tab-1')).toBe(SPAWNED);
  });

  test('a tab that is not a Claude session is left alone', async () => {
    addSession('tab-1', { provider: 'codex' });

    const body = await sessionStart({ session_id: 'tab-1', claude_session_id: RESUMED, source: 'resume' });

    expect(body.updated).toBe(false);
    expect(stored('tab-1')).toBe(SPAWNED);
  });

  test('an unknown tab creates nothing', async () => {
    const body = await sessionStart({ session_id: 'no-such-tab', claude_session_id: RESUMED, source: 'resume' });

    expect(body.updated).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0);
  });

  test('a post without both ids changes nothing', async () => {
    addSession('tab-1');

    await sessionStart({ session_id: 'tab-1', source: 'resume' });
    await sessionStart({ claude_session_id: RESUMED, source: 'resume' });

    expect(stored('tab-1')).toBe(SPAWNED);
  });
});

describe('an account switch after an in-CLI /resume', () => {
  test('carries the resumed conversation and its dir, not the spawn-time one', async () => {
    const dirA = addAccount('acct-a', true);
    const dirB = addAccount('acct-b');
    addSession('tab-1', { accountId: 'acct-a' });
    writeFile(dirA, `${SPAWNED}.jsonl`, '{"spawned":1}\n');
    writeFile(dirA, `${RESUMED}.jsonl`, '{"resumed":1}\n');
    writeFile(dirA, `${RESUMED}/subagents/agent-a.jsonl`, '{"sub":1}\n');
    writeFile(dirA, `${RESUMED}/tool-results/r1.txt`, 'output');

    await sessionStart({ session_id: 'tab-1', claude_session_id: RESUMED, source: 'resume' });
    accountSwitch.assignSessionAccount('tab-1', 'acct-b');

    const landed = path.join(dirB, 'projects', '-Users-x-repo');
    expect(fs.existsSync(path.join(landed, `${RESUMED}.jsonl`))).toBe(true);
    expect(fs.readFileSync(path.join(landed, RESUMED, 'subagents', 'agent-a.jsonl'), 'utf-8')).toBe('{"sub":1}\n');
    expect(fs.existsSync(path.join(landed, RESUMED, 'tool-results', 'r1.txt'))).toBe(true);
    expect(fs.existsSync(path.join(landed, `${SPAWNED}.jsonl`))).toBe(false);
  });
});
