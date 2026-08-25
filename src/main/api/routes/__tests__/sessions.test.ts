/**
 * The PTY teardown routes await kill() and answer from its outcome — a
 * rejection becomes the route's 500, never an unhandled one. Real router,
 * in-memory bun:sqlite; the singleton's getSession/kill shadowed per test.
 */

// Run with: bun test src/main/api
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { PairedDevice } from '../../pairing/pairing-manager';

let db: Database;
mock.module('../../../database', () => ({
  getDatabase: () => db,
}));
mock.module('electron-log', () => ({
  default: { info() {}, warn() {}, error() {} },
}));
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
  safeStorage: { isEncryptionAvailable: () => false },
}));
mock.module('../../../repositories/preferences', () => ({
  getPreference: () => null,
  setPreference: () => {},
  deletePreference: () => {},
}));
// Keeps node-pty's native binding out of the test process; nothing here spawns.
mock.module('node-pty', () => ({
  spawn: () => { throw new Error('no pty spawns in these tests'); },
}));

const { createSessionsRouter } = await import('../sessions');
const { ptyManager } = await import('../../../pty-manager');

/**
 * Per-test shadows over the singleton's prototype methods. getSession only
 * feeds truthiness checks in the routes, so a bare object stands in for a
 * live session.
 */
const patchable = ptyManager as unknown as {
  getSession?: (id: string) => unknown;
  kill?: (id: string) => Promise<void>;
};

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
    )
  `);
  return d;
}

function insertSession(id: string): void {
  db.prepare(`
    INSERT INTO sessions (id, group_id, name, working_dir, state, shell_type, "order", created_at, last_activity_at)
    VALUES (?, 'g1', 'test', '/tmp', 'idle', 'claude', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `).run(id);
}

function sessionRowCount(id: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id = ?').get(id) as { c: number }).c;
}

const device: PairedDevice = {
  id: 'device-1',
  name: 'test-phone',
  platform: 'ios',
  canControl: true,
  canModify: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  lastUsedAt: new Date('2026-01-01T00:00:00Z'),
};

let server: Server;
let baseUrl = '';

beforeAll(() => new Promise<void>((resolve) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.device = device;
    next();
  });
  app.use('/sessions', createSessionsRouter());
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
});

afterEach(() => {
  delete patchable.getSession;
  delete patchable.kill;
});

describe('POST /sessions/:id/stop', () => {
  test('the response waits on kill() and reports success only once it settles', async () => {
    const id = randomUUID();
    patchable.getSession = () => ({});
    let resolveKill: () => void = () => {};
    const killCalls: string[] = [];
    patchable.kill = (killedId: string) => {
      killCalls.push(killedId);
      return new Promise<void>((resolve) => { resolveKill = resolve; });
    };

    const pending = fetch(`${baseUrl}/sessions/${id}/stop`, { method: 'POST' });
    let settled = false;
    const tracked = pending.then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 25));
    // The kill has been asked for but has not settled: no response yet, so
    // success can only ever mean the process is really gone.
    expect(killCalls).toEqual([id]);
    expect(settled).toBe(false);

    resolveKill();
    const res = await tracked;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  test('a kill rejection surfaces as the route 500, not an unhandled rejection', async () => {
    const id = randomUUID();
    patchable.getSession = () => ({});
    patchable.kill = () => Promise.reject(new Error('teardown exploded'));

    const escaped: unknown[] = [];
    const onUnhandled = (err: unknown) => { escaped.push(err); };
    process.on('unhandledRejection', onUnhandled);
    let status = 0;
    let body: unknown = null;
    try {
      const res = await fetch(`${baseUrl}/sessions/${id}/stop`, { method: 'POST' });
      status = res.status;
      body = await res.json();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to stop session' });
    expect(escaped).toEqual([]);
  });
});

describe('DELETE /sessions/:id', () => {
  test('with no running pty, deletes the record without touching kill()', async () => {
    const id = randomUUID();
    insertSession(id);
    const killCalls: string[] = [];
    patchable.kill = (killedId: string) => {
      killCalls.push(killedId);
      return Promise.resolve();
    };

    const res = await fetch(`${baseUrl}/sessions/${id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(killCalls).toEqual([]);
    expect(sessionRowCount(id)).toBe(0);
  });

  test('a kill rejection aborts the delete with a 500, and a retry completes it', async () => {
    const id = randomUUID();
    insertSession(id);
    patchable.getSession = () => ({});
    patchable.kill = () => Promise.reject(new Error('teardown exploded'));

    const escaped: unknown[] = [];
    const onUnhandled = (err: unknown) => { escaped.push(err); };
    process.on('unhandledRejection', onUnhandled);
    let status = 0;
    let body: unknown = null;
    try {
      const res = await fetch(`${baseUrl}/sessions/${id}`, { method: 'DELETE' });
      status = res.status;
      body = await res.json();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to delete session' });
    expect(escaped).toEqual([]);
    // The record survives the failed attempt rather than half-vanishing.
    expect(sessionRowCount(id)).toBe(1);

    // kill() empties its session slot before anything can throw, so the retry
    // finds no live pty and goes straight to removing the record.
    delete patchable.getSession;
    const retry = await fetch(`${baseUrl}/sessions/${id}`, { method: 'DELETE' });
    expect(retry.status).toBe(200);
    expect(sessionRowCount(id)).toBe(0);
  });
});
