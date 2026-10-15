/**
 * GET /api/v1/runs/:key/status through the real HTTP server, so the auth in
 * front of it is the one that ships. In-memory bun:sqlite with the real run
 * schema; the paired device comes from a real PairingManager.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Server } from 'node:http';

let db: Database;
mock.module('../../../database', () => ({ getDatabase: () => db }));
mock.module('electron-log', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata', isPackaged: false, getAppPath: () => '/nonexistent' },
  safeStorage: { isEncryptionAvailable: () => false },
}));
mock.module('../../../repositories/preferences', () => ({
  getPreference: () => null,
  setPreference: () => {},
  deletePreference: () => {},
}));
mock.module('../../../session-routing', () => ({
  routeNewSessionByUsage: () => {},
  sessionTokenRefreshSettled: async () => {},
}));
mock.module('node-pty', () => ({
  spawn: () => { throw new Error('no pty spawns in these tests'); },
}));

const { RUN_TABLES_SQL } = await import('../../../run-tables-sql');
const { PairingManager } = await import('../../pairing/pairing-manager');
const { createHttpServer } = await import('../../http-server');

let server: Server;
let baseUrl = '';
let token = '';

function seed(): void {
  db.exec(RUN_TABLES_SQL);
  const insertRun = db.prepare(
    `INSERT INTO runs (id, initiative_key, initiative_dir, harness_path, bodhi_root, state, created_at, updated_at)
     VALUES (?, ?, '/i', '/h', '/r', ?, ?, ?)`,
  );
  insertRun.run('run-old', 'ABC-7', 'failed', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
  insertRun.run('run-new', 'ABC-7', 'waitingReview', '2026-02-01 00:00:00', '2026-02-02 00:00:00');
  db.prepare(
    `INSERT INTO run_owners (run_id, repo, worktree, branch, base, agent, state, merge_order, pr_number, pr_url)
     VALUES ('run-new', 'api', '/w/api', 'feat/ABC-7-api', 'origin/development', 'lead', 'waitingReview', 0, 12, 'https://github.com/o/api/pull/12')`,
  ).run();
  db.prepare(
    `INSERT INTO run_owners (run_id, repo, worktree, branch, base, state)
     VALUES ('run-new', 'web', '/w/web', 'feat/ABC-7-web', 'origin/development', 'ownerRunning')`,
  ).run();
  const gate = db.prepare(
    `INSERT INTO run_gates (id, run_id, gate, repo, agent, attempt, status, verdict_json, started_at)
     VALUES (?, 'run-new', ?, ?, ?, ?, ?, ?, ?)`,
  );
  gate.run('g1', 2, 'api', 'lead', 1, 'failed', '{"verdict":"fail"}', '2026-02-01 01:00:00');
  gate.run('g2', 2, 'api', 'lead', 2, 'passed', '{"verdict":"pass","blocking_findings":[]}', '2026-02-01 02:00:00');
  gate.run('g3', 2, 'web', 'web-lead', 1, 'running', null, '2026-02-01 03:00:00');
}

function snapshot(): string {
  return JSON.stringify(['runs', 'run_owners', 'run_gates', 'run_events'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
}

beforeAll(async () => {
  db = new Database(':memory:');
  const pairingManager = new PairingManager();
  token = pairingManager.createDevice('Claude Desktop', 'claude-desktop', { canControl: false, canModify: false }).token;
  const result = await createHttpServer({ port: 0, bindAddress: '127.0.0.1', pairingManager });
  server = result.server;
  baseUrl = `http://127.0.0.1:${result.port}/api/v1/runs`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  for (const t of ['run_events', 'run_gates', 'run_owners', 'runs']) db.exec(`DROP TABLE IF EXISTS ${t}`);
  seed();
});

const get = (path: string, auth: string | null = `Bearer ${token}`) =>
  fetch(`${baseUrl}${path}`, auth ? { headers: { Authorization: auth } } : {});

describe('auth', () => {
  test('no credential is 401', async () => {
    expect((await get('/ABC-7/status', null)).status).toBe(401);
  });

  test('a wrong credential is 401', async () => {
    const forged = Buffer.from('nobody:c2VjcmV0').toString('base64');
    expect((await get('/ABC-7/status', `Bearer ${forged}`)).status).toBe(401);
  });

  test('any paired device may read it; no control permission is needed', async () => {
    expect((await get('/ABC-7/status')).status).toBe(200);
  });
});

describe('GET /runs/:key/status', () => {
  test('answers the newest run, each owner with its PR, and the newest attempt per gate', async () => {
    const res = await get('/abc-7/status');
    const body = await res.json();
    expect(body.initiative).toBe('ABC-7');
    expect(body.run).toMatchObject({ id: 'run-new', state: 'waitingReview', kind: 'single' });
    expect(body.owners).toEqual([
      {
        repo: 'api', branch: 'feat/ABC-7-api', agent: 'lead', state: 'waitingReview', blockedReason: null,
        mergeOrder: 0, pr: { number: 12, url: 'https://github.com/o/api/pull/12' },
      },
      { repo: 'web', branch: 'feat/ABC-7-web', agent: null, state: 'ownerRunning', blockedReason: null, mergeOrder: null, pr: null },
    ]);
    expect(body.gates).toEqual([
      { gate: 2, repo: 'api', agent: 'lead', attempt: 2, status: 'passed', verdict: 'pass', startedAt: '2026-02-01 02:00:00' },
      { gate: 2, repo: 'web', agent: 'web-lead', attempt: 1, status: 'running', verdict: null, startedAt: '2026-02-01 03:00:00' },
    ]);
  });

  test('reading changes nothing', async () => {
    const before = snapshot();
    await get('/ABC-7/status');
    expect(snapshot()).toBe(before);
  });

  test('an unknown initiative is 404', async () => {
    expect((await get('/ZZZ-1/status')).status).toBe(404);
  });

  test('a key that is not KEY-N is 400', async () => {
    expect((await get('/not_a_key/status')).status).toBe(400);
  });

  test('there is nothing to write to', async () => {
    const res = await fetch(`${baseUrl}/ABC-7/status`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });
});
