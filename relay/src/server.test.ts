/**
 * The request-body ceiling, over a real socket. Bun enforces it before the
 * handler runs, so a suite calling `createRouter()` directly — which is every
 * other suite here — cannot see it at all.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { openDb } from './db';
import { createRepositories } from './repositories';
import { createRouter } from './http';
import { MAX_JSON_BODY_BYTES, requestBodyCeiling } from './server';

const logger = createLogger('error');

/** The bundle a 12-group / 120-session machine sealed to, measured. */
const REALISTIC_BUNDLE_BYTES = 5 * 1024 * 1024;
/** What Bun accepted before the ceiling was tied to the handoff cap. */
const OLD_WIRE_CEILING = 1024 * 1024;

const servers: { stop: (force?: boolean) => void }[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function start(env: Record<string, string> = {}) {
  const db = openDb(':memory:');
  const repos = createRepositories(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-serve-'));
  dirs.push(dir);
  const { config } = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'http://relay.test', HANDOFF_DIR: dir, ...env });
  const route = createRouter({ config, logger, repos });

  // The same two values index.ts hands Bun. Only the body ceiling is under
  // test here; the WebSocket upgrade paths are exercised elsewhere.
  const server = Bun.serve({
    port: 0,
    maxRequestBodySize: requestBodyCeiling(config),
    fetch: (req, srv) => route(req, srv.requestIP(req)?.address ?? null),
  });
  servers.push(server);

  const user = repos.upsertGithubUser({
    providerUserId: '1',
    displayName: 'Will',
    login: 'will-l',
    email: null,
    avatarUrl: null,
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' }) as { x: string };
  const code = repos.createLinkCode('Old Laptop', new Uint8Array(Buffer.from(x, 'base64url')), new Uint8Array(32).fill(1), 600).code;
  const claim = repos.claimLinkCode(code, user.id);
  if (!claim.ok) throw new Error('fixture could not link a machine');

  const origin = server.url.origin;
  const machineId = claim.machine.id;

  async function put(body: Buffer) {
    const digest = createHash('sha256').update(body).digest('hex');
    const issuedAt = Date.now();
    const message = Buffer.from(['handoff-put:v1', machineId, digest, String(issuedAt)].join('\n'));
    return fetch(`${origin}/api/machines/${machineId}/handoff`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-bodhi-content-sha256': digest,
        'x-bodhi-issued-at': String(issuedAt),
        'x-bodhi-signature': edSign(null, message, privateKey).toString('base64'),
      },
      body,
    });
  }

  return { config, origin, put };
}

/**
 * A body with no content-length, so it is framed chunked. `produced` counts
 * what the generator actually handed over, which is how far the server got
 * before it stopped pulling.
 */
function chunkedBody(totalBytes: number, produced: { bytes: number }): ReadableStream<Uint8Array> {
  const CHUNK = 16 * 1024;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK, totalBytes - sent);
      sent += size;
      produced.bytes = sent;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
}

function postChunked(url: string, totalBytes: number, produced: { bytes: number }) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: chunkedBody(totalBytes, produced),
    duplex: 'half',
  } as RequestInit);
}

describe('what the socket will accept', () => {
  test('admits a bundle from a real machine, which the old ceiling did not', async () => {
    const { config, put } = start();
    expect(REALISTIC_BUNDLE_BYTES).toBeGreaterThan(OLD_WIRE_CEILING);
    expect(requestBodyCeiling(config)).toBeGreaterThan(REALISTIC_BUNDLE_BYTES);

    const res = await put(randomBytes(REALISTIC_BUNDLE_BYTES));
    expect(res.status).toBe(200);
    const { handoff } = (await res.json()) as { handoff: { byteSize: number } };
    expect(handoff.byteSize).toBe(REALISTIC_BUNDLE_BYTES);
  });

  test('leaves headroom over the cap, so the cap is refused by the handler and not the socket', async () => {
    // A small cap, so an over-cap body is cheap to send. What is pinned is
    // that the refusal carries a reason and a size rather than an empty 413.
    const { put } = start({ HANDOFF_MAX_BYTES: String(64 * 1024) });
    const res = await put(randomBytes(96 * 1024));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'handoff_too_large', maxBytes: 65536 });
  });

  test('bounds a chunked body, which declares no length to check', async () => {
    const { config, origin } = start();
    const produced = { bytes: 0 };
    const total = 8 * 1024 * 1024;

    // Why `readJson` counts bytes itself instead of leaning on the setting
    // above: the ceiling this server runs with is the handoff cap, three
    // orders of magnitude past anything a JSON route may accept. Bun's own
    // treatment of it is beside the point and not stable anyway — 1.3
    // ignored it for a body read as a stream, 1.4 enforces it — so this
    // suite pins the relay's bound and not Bun's.
    expect(requestBodyCeiling(config)).toBeGreaterThan(MAX_JSON_BODY_BYTES * 100);

    const res = await postChunked(`${origin}/link`, total, produced);

    // A reasoned 413 is the handler's. Bun's, when it refuses at the socket,
    // carries an empty body — so this also pins which of the two answered.
    // 400 would mean the body was buffered AND parsed by `/link`'s handler.
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(produced.bytes).toBeLessThan(total / 2);
  });

  test('bounds a chunked body on the other unauthenticated route too', async () => {
    const { origin } = start();
    const produced = { bytes: 0 };

    const res = await postChunked(`${origin}/api/machines/abc/shares`, 4 * 1024 * 1024, produced);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });

  test('exempts only the handoff upload, not every route under it', async () => {
    const { origin } = start();
    // `/handoff/bundle` is a download; nothing there reads a body.
    const res = await fetch(`${origin}/api/machines/abc/handoff/bundle`, {
      method: 'PUT',
      body: randomBytes(MAX_JSON_BODY_BYTES + 1024),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });

  test('still bounds every route that is not a handoff upload', async () => {
    const { origin } = start();
    const res = await fetch(`${origin}/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineName: 'x'.repeat(MAX_JSON_BODY_BYTES) }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });
});
