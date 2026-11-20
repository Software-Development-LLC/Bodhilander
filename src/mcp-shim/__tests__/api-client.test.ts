/**
 * The extension's way in: discovery and credential files on disk, then a real
 * loopback HTTP server standing in for Bodhilander's API.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiClient, httpSend, loadConnection, readFileOrNull, ToolError } from '../api-client';
import {
  NOT_ENABLED_MESSAGE,
  DISCOVERY_VERSION,
  credentialPath,
  discoveryPath,
  serializeDiscovery,
} from '../../shared/claude-desktop';

let userData: string;
let server: Server;
let port = 0;
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {};

beforeAll(() => new Promise<void>((resolve) => {
  server = createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1', () => {
    port = (server.address() as AddressInfo).port;
    resolve();
  });
}));

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-mcp-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

function enable(atPort = port, token = 'tok-123'): void {
  fs.mkdirSync(path.dirname(discoveryPath(userData)), { recursive: true });
  fs.writeFileSync(credentialPath(userData), `${token}\n`);
  fs.writeFileSync(
    discoveryPath(userData),
    serializeDiscovery({ version: DISCOVERY_VERSION, port: atPort, credentialPath: credentialPath(userData) }),
  );
}

function client(timeoutMs = 2000) {
  return createApiClient({ send: httpSend, readFile: readFileOrNull, userDataDirs: [userData], timeoutMs });
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

describe('discovery', () => {
  test('no discovery file is the friendly not-enabled error', async () => {
    const err = await failure(client().get('/sessions'));
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toBe(NOT_ENABLED_MESSAGE);
  });

  test('a discovery file without its credential is the same error', () => {
    enable();
    fs.rmSync(credentialPath(userData));
    expect(() => loadConnection({ readFile: readFileOrNull, userDataDirs: [userData] })).toThrow(NOT_ENABLED_MESSAGE);
  });

  test('an empty credential is the same error', () => {
    enable(port, '   ');
    expect(() => loadConnection({ readFile: readFileOrNull, userDataDirs: [userData] })).toThrow(NOT_ENABLED_MESSAGE);
  });

  test('a malformed discovery file says so', () => {
    enable();
    fs.writeFileSync(discoveryPath(userData), '{ not json');
    expect(() => loadConnection({ readFile: readFileOrNull, userDataDirs: [userData] })).toThrow('unreadable');
  });

  test('the first candidate holding a file wins', () => {
    enable();
    const conn = loadConnection({ readFile: readFileOrNull, userDataDirs: [path.join(userData, 'absent'), userData] });
    expect(conn).toEqual({ port, token: 'tok-123' });
  });
});

describe('requests', () => {
  test('goes to loopback on the discovered port with the bearer token', async () => {
    enable();
    let seen: { url?: string; auth?: string; body?: string; type?: string } = {};
    handler = (req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen = { url: req.url, auth: req.headers.authorization, body, type: req.headers['content-type'] };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    };
    expect(await client().post('/sessions', { a: 1 })).toEqual({ ok: true });
    expect(seen).toEqual({ url: '/api/v1/sessions', auth: 'Bearer tok-123', body: '{"a":1}', type: 'application/json' });
  });

  test('401 means the device was unpaired or access disabled', async () => {
    enable();
    handler = (_req, res) => { res.statusCode = 401; res.end(JSON.stringify({ error: 'Invalid or expired token' })); };
    const err = await failure(client().get('/sessions'));
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toContain('access was disabled or the device was unpaired');
  });

  test('403 names the missing permission', async () => {
    enable();
    handler = (_req, res) => { res.statusCode = 403; res.end(JSON.stringify({ error: 'Modify permission required' })); };
    const err = await failure(client().post('/sessions', {}));
    expect(err.message).toContain('Modify permission required');
  });

  test('other failures carry the status and the server\'s reason', async () => {
    enable();
    handler = (_req, res) => { res.statusCode = 404; res.end(JSON.stringify({ error: 'Session not found' })); };
    const err = await failure(client().get('/sessions/x'));
    expect(err.message).toBe('Bodhilander answered 404: Session not found');
  });

  test('a closed port is reported as Bodhilander not running', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    enable(deadPort);
    const err = await failure(client().get('/sessions'));
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toContain(`isn't reachable at 127.0.0.1:${deadPort}`);
  });

  test('a server that never answers times out instead of hanging', async () => {
    enable();
    handler = () => {};
    const err = await failure(client(200).get('/sessions'));
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toContain('did not answer');
  });
});
