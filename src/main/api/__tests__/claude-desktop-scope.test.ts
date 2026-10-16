/**
 * The Claude Desktop device's limits, enforced by the server that ships: the
 * real HTTP and WebSocket servers, a real PairingManager, in-memory SQLite,
 * and the pty singleton's methods shadowed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import WebSocket from 'ws';

let db: Database;
mock.module('../../database', () => ({ getDatabase: () => db }));
mock.module('electron-log', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata', isPackaged: false, getAppPath: () => '/nonexistent' },
  safeStorage: { isEncryptionAvailable: () => false },
}));
mock.module('../../repositories/preferences', () => ({
  getPreference: () => null,
  setPreference: () => {},
  deletePreference: () => {},
}));
mock.module('../../session-routing', () => ({
  routeNewSessionByUsage: () => {},
  sessionTokenRefreshSettled: async () => {},
}));
mock.module('node-pty', () => ({
  spawn: () => { throw new Error('no pty spawns in these tests'); },
}));

const { PairingManager } = await import('../pairing/pairing-manager');
const { createHttpServer } = await import('../http-server');
const { createWsServer } = await import('../ws-server');
const { authenticateDevice } = await import('../middleware/auth');
const { ptyManager } = await import('../../pty-manager');
const { forgetClaudeDesktopSessions } = await import('../claude-desktop-scope');

const REPO = os.tmpdir();
const GROUP_ID = randomUUID();

const patchable = ptyManager as unknown as {
  getSession?: (id: string) => unknown;
  createSession?: (id: string, cwd: string, launch: boolean) => void;
  write?: (id: string, data: string) => void;
  getBuffer?: (id: string) => string;
};

let server: Server;
let base = '';
let desktopToken = '';
let phoneToken = '';
let pairingManager: InstanceType<typeof PairingManager>;
let spawned: { id: string; cwd: string; launch: boolean }[];
let written: { id: string; data: string }[];

function schema(): void {
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL, working_dir TEXT, state TEXT,
      shell_type TEXT DEFAULT 'bash', "order" INTEGER DEFAULT 0, created_at TEXT, last_activity_at TEXT,
      claude_session_id TEXT DEFAULT NULL, ended_at TEXT DEFAULT NULL, duration_seconds REAL DEFAULT 0,
      claude_account_id TEXT DEFAULT NULL, provider TEXT NOT NULL DEFAULT 'claude',
      failover_from_account_id TEXT DEFAULT NULL, failover_prev_account_id TEXT DEFAULT NULL
    );
    CREATE TABLE groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT DEFAULT '#888888', working_dir TEXT DEFAULT '',
      "order" INTEGER DEFAULT 0, created_at TEXT, parent_id TEXT DEFAULT NULL, collapsed INTEGER DEFAULT 0,
      claude_account_id TEXT DEFAULT NULL, github_project_number INTEGER DEFAULT NULL,
      github_project_name TEXT DEFAULT NULL, clone_root TEXT DEFAULT NULL
    );
    CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, event_type TEXT, data TEXT, created_at TEXT);
  `);
  db.prepare(`INSERT INTO groups (id, name, working_dir, created_at) VALUES (?, 'Repo', ?, '2026-01-01')`).run(GROUP_ID, REPO);
  db.prepare(`INSERT INTO groups (id, name, working_dir, created_at) VALUES (?, 'Elsewhere', '', '2026-01-01')`).run(randomUUID());
}

function insertSession(id: string, workingDir: string, shellType = 'claude'): void {
  db.prepare(`
    INSERT INTO sessions (id, group_id, name, working_dir, state, shell_type, "order", created_at, last_activity_at)
    VALUES (?, ?, 'existing', ?, 'idle', ?, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `).run(id, GROUP_ID, workingDir, shellType);
}

beforeAll(async () => {
  db = new Database(':memory:');
  schema();
  pairingManager = new PairingManager();
  desktopToken = pairingManager.createDevice('Claude Desktop', 'claude-desktop', { canControl: true, canModify: true }).token;
  phoneToken = pairingManager.createDevice('Phone', 'ios', { canControl: true, canModify: true }).token;
  const result = await createHttpServer({ port: 0, bindAddress: '127.0.0.1', pairingManager });
  server = result.server;
  createWsServer(server, pairingManager);
  base = `http://127.0.0.1:${result.port}/api/v1`;
});

afterAll(() => {
  server?.closeAllConnections?.();
  server?.close();
});

beforeEach(() => {
  spawned = [];
  written = [];
  forgetClaudeDesktopSessions();
  patchable.createSession = (id, cwd, launch) => { spawned.push({ id, cwd, launch }); };
  patchable.getSession = () => ({ provider: { id: 'claude' } });
  patchable.write = (id, data) => { written.push({ id, data }); };
  patchable.getBuffer = () => '> ';
});

afterEach(() => {
  delete patchable.createSession;
  delete patchable.getSession;
  delete patchable.write;
  delete patchable.getBuffer;
});

function call(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function startAsDesktop(workingDir = REPO): Promise<Response> {
  return call('POST', '/sessions', desktopToken, { groupId: randomUUID(), name: 'from desktop', workingDir, launchClaude: false });
}

describe('routes the extension uses', () => {
  test.each([
    ['GET', '/sessions'],
    ['GET', '/groups'],
  ])('%s %s is allowed', async (method, path) => {
    expect((await call(method, path, desktopToken)).status).toBe(200);
  });

  test('reading one session and its chat events is allowed', async () => {
    const id = randomUUID();
    insertSession(id, REPO);
    expect((await call('GET', `/sessions/${id}`, desktopToken)).status).toBe(200);
    expect((await call('GET', `/sessions/${id}/chat-events`, desktopToken)).status).not.toBe(403);
  });

  test('run status passes the scope', async () => {
    expect((await call('GET', '/runs/ABC-1/status', desktopToken)).status).not.toBe(403);
  });
});

describe('everything else is refused', () => {
  test.each([
    ['DELETE', 'session'],
    ['PATCH', 'session'],
    ['POST', 'stop'],
    ['POST', 'start'],
  ])('%s on a session (%s) is 403', async (method, kind) => {
    const id = randomUUID();
    insertSession(id, REPO);
    const path = kind === 'session' ? `/sessions/${id}` : `/sessions/${id}/${kind}`;
    const res = await call(method, path, desktopToken, method === 'PATCH' ? { name: 'x' } : undefined);
    expect(res.status).toBe(403);
  });

  test.each([
    ['GET', '/pairing/devices'],
    ['GET', '/system/info'],
    ['POST', '/web-push/subscribe'],
    ['POST', '/groups'],
  ])('%s %s is 403', async (method, path) => {
    expect((await call(method, path, desktopToken, method === 'POST' ? {} : undefined)).status).toBe(403);
  });

  test('another device is not affected by the narrowing', async () => {
    expect((await call('GET', '/pairing/devices', phoneToken)).status).toBe(200);
  });
});

describe('POST /sessions from Claude Desktop', () => {
  test('always launches Claude Code, in the known repo\'s own group', async () => {
    const res = await startAsDesktop();
    const body = await res.json() as { session: { id: string; groupId: string; shellType: string } };
    expect(res.status).toBe(201);
    expect(body.session.groupId).toBe(GROUP_ID);
    expect(body.session.shellType).toBe('claude');
    expect(spawned).toEqual([{ id: body.session.id, cwd: REPO, launch: true }]);
  });

  test('refuses a folder Bodhilander does not know', async () => {
    const res = await startAsDesktop(os.homedir() + '/definitely-not-a-repo');
    expect(res.status).toBe(403);
    expect(spawned).toEqual([]);
  });

  test('refuses a known repo whose folder is gone', async () => {
    const gone = `${REPO}/bodhi-deleted-repo-${randomUUID()}`;
    db.prepare(`INSERT INTO groups (id, name, working_dir, created_at) VALUES (?, 'Gone', ?, '2026-01-01')`).run(randomUUID(), gone);
    expect((await startAsDesktop(gone)).status).toBe(403);
    expect(spawned).toEqual([]);
  });

  test('a plain shell\'s folder is not a known repo', async () => {
    const shellDir = os.homedir();
    insertSession(randomUUID(), shellDir, 'bash');
    expect((await startAsDesktop(shellDir)).status).toBe(403);
  });
});

describe('terminal access', () => {
  test('works for a session Claude Desktop started', async () => {
    const created = await (await startAsDesktop()).json() as { session: { id: string } };
    const id = created.session.id;
    expect((await call('POST', `/terminal/${id}/input`, desktopToken, { data: 'hi' })).status).toBe(200);
    expect((await call('GET', `/terminal/${id}/buffer`, desktopToken)).status).toBe(200);
    expect(written).toEqual([{ id, data: 'hi' }]);
  });

  test('ends when that Claude Code exits', async () => {
    const created = await (await startAsDesktop()).json() as { session: { id: string } };
    const id = created.session.id;
    (ptyManager as unknown as { emit(event: string, payload: unknown): boolean }).emit('exit', { id, exitCode: 0 });
    expect((await call('POST', `/terminal/${id}/input`, desktopToken, { data: 'hi' })).status).toBe(403);
    expect(written).toEqual([]);
  });

  test('is refused while the session runs a plain shell, even one it started', async () => {
    const created = await (await startAsDesktop()).json() as { session: { id: string } };
    patchable.getSession = () => ({ provider: null });
    const res = await call('POST', `/terminal/${created.session.id}/input`, desktopToken, { data: 'whoami\r' });
    expect(res.status).toBe(403);
    expect(written).toEqual([]);
  });

  test('a phone may still type into a shell', async () => {
    const id = randomUUID();
    insertSession(id, REPO);
    patchable.getSession = () => ({ provider: null });
    expect((await call('POST', `/terminal/${id}/input`, phoneToken, { data: 'ls\r' })).status).toBe(200);
  });

  test('is refused for any other session', async () => {
    const id = randomUUID();
    insertSession(id, REPO);
    expect((await call('POST', `/terminal/${id}/input`, desktopToken, { data: 'rm -rf /\r' })).status).toBe(403);
    expect((await call('GET', `/terminal/${id}/buffer`, desktopToken)).status).toBe(403);
    expect(written).toEqual([]);
  });
});

describe('loopback only', () => {
  function authAs(remoteAddress: string, url: string, token: string) {
    let status = 200;
    let passed = false;
    const req = {
      headers: { authorization: `Bearer ${token}` },
      socket: { remoteAddress },
      method: 'GET',
      originalUrl: url,
    } as unknown as Request;
    const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
    authenticateDevice(pairingManager)(req, res, () => { passed = true; });
    return { status, passed };
  }

  test('the Claude Desktop token is refused from the LAN', () => {
    expect(authAs('192.168.1.20', '/api/v1/sessions', desktopToken)).toEqual({ status: 403, passed: false });
  });

  test('and accepted from loopback, including IPv4-mapped IPv6', () => {
    expect(authAs('::ffff:127.0.0.1', '/api/v1/sessions', desktopToken).passed).toBe(true);
  });

  test('a phone is still accepted from the LAN', () => {
    expect(authAs('192.168.1.20', '/api/v1/sessions', phoneToken).passed).toBe(true);
  });
});

describe('WebSocket', () => {
  function authenticate(token: string): Promise<{ closeCode: number | null; connected: boolean }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(base.replace('http', 'ws').replace('/api/v1', '/'));
      let connected = false;
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('message', (raw) => {
        if (JSON.parse(String(raw)).type === 'connected') {
          connected = true;
          ws.close();
        }
      });
      ws.on('close', (code) => resolve({ closeCode: connected ? null : code, connected }));
    });
  }

  test('the Claude Desktop token cannot open one', async () => {
    expect(await authenticate(desktopToken)).toEqual({ closeCode: 4401, connected: false });
  });

  test('a phone still can', async () => {
    expect((await authenticate(phoneToken)).connected).toBe(true);
  });
});
