/**
 * VAPID identity and the endpoint allow-list. The JWT is verified against the
 * very key a browser subscribes with, which is the whole contract — one only
 * this file could validate would prove nothing about a real push service.
 */
import { describe, expect, test } from 'bun:test';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { openDb } from './db';
import { createRepositories } from './repositories';
import { createVapid, VAPID_KV_KEY } from './push/vapid';
import { createPushDispatcher, isAllowedPushEndpoint, MAX_ENDPOINT_LENGTH } from './push/send';
import { toArrayBuffer } from './crypto';

const logger = createLogger('error');
const base = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'http://relay.test' }).config;

function ctx(env: Record<string, string | undefined> = {}) {
  const db = openDb(':memory:');
  const repos = createRepositories(db);
  const config = env.VAPID_PUBLIC_KEY || env.VAPID_SUBJECT
    ? loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'http://relay.test', ...env }).config
    : base;
  return { repos, vapid: createVapid({ config, repos, logger }), config };
}

/** Split `vapid t=<jwt>,k=<key>` into its parts. */
function parseAuthorization(header: string): { jwt: string; key: string } {
  const match = /^vapid t=([^,]+),k=(.+)$/.exec(header);
  if (!match) throw new Error(`not a VAPID header: ${header}`);
  return { jwt: match[1]!, key: match[2]! };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Verify an ES256 JWT the way a push service would: against the `k=` key. */
async function verifyJwt(jwt: string, publicKeyB64: string): Promise<boolean> {
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  const point = new Uint8Array(Buffer.from(publicKeyB64, 'base64url'));
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: Buffer.from(point.subarray(1, 33)).toString('base64url'),
      y: Buffer.from(point.subarray(33, 65)).toString('base64url'),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toArrayBuffer(new Uint8Array(Buffer.from(signature, 'base64url'))),
    toArrayBuffer(new TextEncoder().encode(`${header}.${payload}`)),
  );
}

describe('VAPID keys', () => {
  test('mints a keypair on first use and stores it', async () => {
    const { repos, vapid } = ctx();
    expect(repos.getKv(VAPID_KV_KEY)).toBeNull();
    const key = await vapid.publicKey();
    expect(Buffer.from(key, 'base64url').length).toBe(65);
    expect(repos.getKv(VAPID_KV_KEY)).toContain(key);
  });

  test('a second instance over the same database reuses the stored pair', async () => {
    const { repos, vapid } = ctx();
    const first = await vapid.publicKey();
    const reopened = createVapid({ config: base, repos, logger });
    expect(await reopened.publicKey()).toBe(first);
  });

  test('a corrupt stored pair is replaced, and the replacement is STORED', async () => {
    const { repos } = ctx();
    repos.setKv(VAPID_KV_KEY, 'not json');
    const vapid = createVapid({ config: base, repos, logger });
    const key = await vapid.publicKey();
    expect(Buffer.from(key, 'base64url').length).toBe(65);

    // The row has to be replaced, not merely ignored. The write is
    // insert-if-absent, so a corrupt row left in place would swallow every
    // replacement — minting a fresh unstored key on each restart and orphaning
    // every subscription, forever. Asserting "65 bytes" alone missed that.
    expect(repos.getKv(VAPID_KV_KEY)).toContain(key);
    const restarted = createVapid({ config: base, repos, logger });
    expect(await restarted.publicKey()).toBe(key);
  });

  test('an environment-supplied pair wins, and nothing is written to the database', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
    const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as { d?: string };

    const { repos, vapid } = ctx({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: jwk.d });
    expect(await vapid.publicKey()).toBe(publicKey);
    expect(repos.getKv(VAPID_KV_KEY)).toBeNull();
  });
});

describe('the Authorization header', () => {
  test('carries a JWT that verifies against the advertised public key', async () => {
    const { vapid } = ctx();
    const { jwt, key } = parseAuthorization(await vapid.authorization('https://push.example.com/send/abc'));
    expect(key).toBe(await vapid.publicKey());
    expect(await verifyJwt(jwt, key)).toBe(true);
  });

  test('is addressed to the endpoint ORIGIN, never its path', async () => {
    const { vapid } = ctx();
    // The path is the subscription secret. Putting it in a token that travels
    // to a third party would be handing the secret away.
    const { jwt } = parseAuthorization(await vapid.authorization('https://push.example.com/send/secret-token'));
    const claims = decodeSegment(jwt.split('.')[1]!);
    expect(claims.aud).toBe('https://push.example.com');
    expect(JSON.stringify(claims)).not.toContain('secret-token');
  });

  test('declares ES256 and carries the configured subject and an expiry', async () => {
    const { vapid } = ctx({ VAPID_SUBJECT: 'mailto:ops@example.com' });
    const { jwt } = parseAuthorization(await vapid.authorization('https://push.example.com/send/abc'));
    const [headerSeg, payloadSeg] = jwt.split('.') as [string, string];
    expect(decodeSegment(headerSeg)).toEqual({ typ: 'JWT', alg: 'ES256' });

    const claims = decodeSegment(payloadSeg) as { sub: string; exp: number };
    expect(claims.sub).toBe('mailto:ops@example.com');
    const hoursOut = (claims.exp - Math.floor(Date.now() / 1000)) / 3600;
    expect(hoursOut).toBeGreaterThan(1);
    // RFC 8292 caps a VAPID token at 24 hours.
    expect(hoursOut).toBeLessThanOrEqual(24);
  });

  test('reuses one token per audience, and keeps different audiences apart', async () => {
    const { vapid } = ctx();
    const a1 = parseAuthorization(await vapid.authorization('https://push.example.com/send/1'));
    const a2 = parseAuthorization(await vapid.authorization('https://push.example.com/send/2'));
    const b = parseAuthorization(await vapid.authorization('https://updates.push.services.mozilla.com/wpush/v2/x'));
    expect(a2.jwt).toBe(a1.jwt);
    expect(b.jwt).not.toBe(a1.jwt);
    expect(decodeSegment(b.jwt.split('.')[1]!).aud).toBe('https://updates.push.services.mozilla.com');
  });

  test('re-signs once the cached token nears its expiry', async () => {
    const { repos } = ctx();
    let clock = Date.now();
    const vapid = createVapid({ config: base, repos, logger, now: () => clock });
    const first = parseAuthorization(await vapid.authorization('https://push.example.com/send/1')).jwt;

    clock += 11 * 60 * 60 * 1000; // still inside the window
    expect(parseAuthorization(await vapid.authorization('https://push.example.com/send/1')).jwt).toBe(first);

    clock += 2 * 60 * 60 * 1000; // past it
    const refreshed = parseAuthorization(await vapid.authorization('https://push.example.com/send/1')).jwt;
    expect(refreshed).not.toBe(first);
    expect(await verifyJwt(refreshed, await vapid.publicKey())).toBe(true);
  });
});

describe('isAllowedPushEndpoint', () => {
  test.each([
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
    'https://fcm.googleapis.com/fcm/send/abc:APA91b',
    'https://web.push.apple.com/QK1234',
  ])('allows the real push services (%s)', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  test.each([
    ['a trailing-dot internal name', 'https://metadata.google.internal./a'],
    ['a trailing-dot loopback', 'https://localhost./a'],
    ['a trailing-dot mDNS name', 'https://printer.local./a'],
    ['a trailing-dot cluster name', 'https://vault.svc.cluster.local./a'],
    ['http, not https', 'http://push.example.com/a'],
    ['loopback by name', 'https://localhost/a'],
    ['loopback by address', 'https://127.0.0.1/a'],
    ['link-local metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['an IPv6 literal', 'https://[fd00::1]/a'],
    ['an mDNS name', 'https://printer.local/a'],
    ['a cloud metadata alias', 'https://metadata.google.internal/a'],
    ['an explicit port', 'https://push.example.com:9200/a'],
    ['embedded credentials', 'https://a:b@push.example.com/a'],
    ['a file URL', 'file:///etc/passwd'],
    ['nonsense', 'https://'],
    ['empty', ''],
  ])('refuses %s', (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  test('refuses an endpoint past the length cap', () => {
    const long = `https://push.example.com/${'a'.repeat(MAX_ENDPOINT_LENGTH)}`;
    expect(isAllowedPushEndpoint(long)).toBe(false);
  });
});

describe('the dispatcher', () => {
  const sealed = new Uint8Array([1, 2, 3, 4]);

  function dispatcherWith(handler: (req: Request) => Response) {
    const { vapid } = ctx();
    // `Request` exposes `redirect`/`signal` as readonly and normalises them, so
    // the init is recorded ALONGSIDE the request rather than read back off it.
    const seen: Array<{ req: Request; init?: RequestInit }> = [];
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input as string, { ...init, signal: undefined, redirect: undefined });
      seen.push({ req, init });
      return Promise.resolve(handler(req));
    }) as unknown as typeof fetch;
    return { dispatcher: createPushDispatcher({ vapid, fetchImpl }), seen };
  }

  test('POSTs the sealed body with the aes128gcm envelope', async () => {
    const { dispatcher, seen } = dispatcherWith(() => new Response(null, { status: 201 }));
    const result = await dispatcher.deliver('https://push.example.com/send/abc', sealed);

    expect(result).toEqual({ status: 201, gone: false });
    const req = seen[0]!.req;
    expect(req.method).toBe('POST');
    expect(req.headers.get('content-encoding')).toBe('aes128gcm');
    expect(req.headers.get('content-type')).toBe('application/octet-stream');
    expect(req.headers.get('authorization')).toStartWith('vapid t=');
    expect(req.headers.get('ttl')).toBeTruthy();
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(sealed);
  });

  test.each([404, 410])('reports %d as gone, so the caller reaps the row', async (status) => {
    const { dispatcher } = dispatcherWith(() => new Response(null, { status }));
    expect(await dispatcher.deliver('https://push.example.com/send/abc', sealed)).toEqual({ status, gone: true });
  });

  test.each([429, 500, 502])('leaves %d alone — the next attention event retries', async (status) => {
    const { dispatcher } = dispatcherWith(() => new Response(null, { status }));
    expect(await dispatcher.deliver('https://push.example.com/send/abc', sealed)).toEqual({ status, gone: false });
  });

  test('does not follow a redirect, and does not reap the row for one', async () => {
    // The allow-list checks the URL we are GIVEN. Following a hop would let a
    // host that passes every check hand the relay a URL nothing checked —
    // discarding https-only, no-port and no-address-literal in one move.
    const { dispatcher, seen } = dispatcherWith(
      () => new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    );
    const result = await dispatcher.deliver('https://push.attacker.example/x', sealed);

    expect(result).toEqual({ status: 307, gone: false, redirected: true });
    expect(seen.length).toBe(1);
    expect(seen[0]!.init?.redirect).toBe('manual');
    // NOT gone: reaping would delete the row and re-sync the agent, which is a
    // reply channel — an exists/doesn't-exist oracle, one probe at a time.
  });

  test.each([301, 302, 303, 307, 308])('refuses to follow a %d', async (status) => {
    const { dispatcher } = dispatcherWith(() => new Response(null, { status }));
    const result = await dispatcher.deliver('https://push.example.com/send/abc', sealed);
    expect(result.redirected).toBe(true);
    expect(result.gone).toBe(false);
  });

  test('bounds how long one endpoint can hold the batch', async () => {
    const { dispatcher, seen } = dispatcherWith(() => new Response(null, { status: 201 }));
    await dispatcher.deliver('https://push.example.com/send/abc', sealed);
    // Without this a deliberately slow endpoint pins the socket and stalls
    // every later item in its batch, including the reap re-sync.
    expect(seen[0]!.init?.signal).toBeTruthy();
    expect(seen[0]!.init!.signal!.aborted).toBe(false);
  });

  test('never dials a disallowed endpoint, even one already in the database', async () => {
    const { dispatcher, seen } = dispatcherWith(() => new Response(null, { status: 201 }));
    // A row could predate the allow-list. Reported as gone so it gets reaped
    // rather than retried forever.
    const result = await dispatcher.deliver('http://169.254.169.254/latest/meta-data/', sealed);
    expect(result).toEqual({ status: null, gone: true });
    expect(seen.length).toBe(0);
  });
});
