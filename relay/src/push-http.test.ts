/**
 * The web-push HTTP surface (M5.3). Three routes, and the interesting part of
 * all three is the refusals: who may call them, what an endpoint is allowed to
 * be (the SSRF boundary), and what happens when someone fills the table.
 */
import { describe, expect, test } from 'bun:test';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { openDb, type RelayDb } from './db';
import { createRepositories, MAX_PUSH_SUBSCRIPTIONS_PER_USER, type Repositories, type User } from './repositories';
import { createRouter } from './http';
import { createVapid } from './push/vapid';
import { createRateLimiter } from './rate-limit';

const logger = createLogger('error');
const { config } = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'http://relay.test' });

/** A valid-looking subscription: an uncompressed P-256 point and 16 auth bytes. */
const P256DH = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url');
const AUTH = Buffer.alloc(16, 3).toString('base64url');
const ENDPOINT = 'https://push.example.com/send/abc123';

interface Fixture {
  db: RelayDb;
  repos: Repositories;
  route: ReturnType<typeof createRouter>;
  owner: User;
  other: User;
  ownerCookie: string;
  otherCookie: string;
  changed: string[];
}

function fixture(over: { rateLimiter?: ReturnType<typeof createRateLimiter>; withVapid?: boolean } = {}): Fixture {
  const db = openDb(':memory:');
  const repos = createRepositories(db);
  const changed: string[] = [];
  const route = createRouter({
    config,
    logger,
    repos,
    rateLimiter: over.rateLimiter,
    vapid: over.withVapid === false ? undefined : createVapid({ config, repos, logger }),
    onPushSubscriptionsChanged: (userId) => changed.push(userId),
  });
  const owner = repos.upsertGithubUser({
    providerUserId: '1',
    displayName: 'Will',
    login: 'will-l',
    email: null,
    avatarUrl: null,
  });
  const other = repos.upsertGithubUser({
    providerUserId: '2',
    displayName: 'Dana',
    login: 'dana-k',
    email: null,
    avatarUrl: null,
  });
  return {
    db,
    repos,
    route,
    owner,
    other,
    ownerCookie: `bdl_session=${repos.createSession(owner.id, 3600).token}`,
    otherCookie: `bdl_session=${repos.createSession(other.id, 3600).token}`,
    changed,
  };
}

function post(path: string, cookie: string | null, body: unknown): Request {
  return new Request(`http://relay.test${path}`, {
    method: 'POST',
    headers: cookie ? { cookie, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie: string | null): Request {
  return new Request(`http://relay.test${path}`, { headers: cookie ? { cookie } : {} });
}

const subscribeBody = (endpoint = ENDPOINT) => ({ endpoint, keys: { p256dh: P256DH, auth: AUTH } });

describe('GET /api/push/vapid-key', () => {
  test('needs a session', async () => {
    const f = fixture();
    expect((await f.route(get('/api/push/vapid-key', null), '1.1.1.1')).status).toBe(401);
  });

  test('returns an uncompressed P-256 point, and the same one every time', async () => {
    const f = fixture();
    const first = (await (await f.route(get('/api/push/vapid-key', f.ownerCookie), '1.1.1.1')).json()) as {
      key: string;
    };
    const bytes = Buffer.from(first.key, 'base64url');
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);

    const second = (await (await f.route(get('/api/push/vapid-key', f.ownerCookie), '1.1.1.1')).json()) as {
      key: string;
    };
    expect(second.key).toBe(first.key);
  });

  test('a minted key is persisted, so a restart keeps every subscription alive', async () => {
    const f = fixture();
    const { key } = (await (await f.route(get('/api/push/vapid-key', f.ownerCookie), '1.1.1.1')).json()) as {
      key: string;
    };
    // A second router over the SAME database is what a process restart looks
    // like from here. A fresh key would silently orphan every subscribed device.
    const restarted = createRouter({
      config,
      logger,
      repos: f.repos,
      vapid: createVapid({ config, repos: f.repos, logger }),
    });
    const after = (await (await restarted(get('/api/push/vapid-key', f.ownerCookie), '1.1.1.1')).json()) as {
      key: string;
    };
    expect(after.key).toBe(key);
  });

  test('says so plainly when push is not configured', async () => {
    const f = fixture({ withVapid: false });
    const res = await f.route(get('/api/push/vapid-key', f.ownerCookie), '1.1.1.1');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'push_unavailable' });
  });
});

describe('POST /api/push/subscribe', () => {
  test('needs a session', async () => {
    const f = fixture();
    expect((await f.route(post('/api/push/subscribe', null, subscribeBody()), '1.1.1.1')).status).toBe(401);
  });

  test('registers the browser and tells the gateway', async () => {
    const f = fixture();
    const res = await f.route(post('/api/push/subscribe', f.ownerCookie, subscribeBody()), '1.1.1.1');
    expect(res.status).toBe(204);
    const subs = f.repos.listPushSubscriptions(f.owner.id);
    expect(subs.length).toBe(1);
    expect(subs[0]!.endpoint).toBe(ENDPOINT);
    expect(f.changed).toEqual([f.owner.id]);
  });

  test('re-subscribing the same endpoint refreshes the keys instead of duplicating', async () => {
    const f = fixture();
    await f.route(post('/api/push/subscribe', f.ownerCookie, subscribeBody()), '1.1.1.1');
    const rotated = Buffer.alloc(16, 9).toString('base64url');
    await f.route(
      post('/api/push/subscribe', f.ownerCookie, { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: rotated } }),
      '1.1.1.1',
    );
    const subs = f.repos.listPushSubscriptions(f.owner.id);
    expect(subs.length).toBe(1);
    expect(subs[0]!.auth).toBe(rotated);
  });

  test('a browser that signs in as someone else takes its endpoint with it', async () => {
    const f = fixture();
    await f.route(post('/api/push/subscribe', f.ownerCookie, subscribeBody()), '1.1.1.1');
    await f.route(post('/api/push/subscribe', f.otherCookie, subscribeBody()), '1.1.1.1');
    // Otherwise the previous account's alerts keep arriving on a device that
    // has been handed to a different person.
    expect(f.repos.listPushSubscriptions(f.owner.id).length).toBe(0);
    expect(f.repos.listPushSubscriptions(f.other.id).length).toBe(1);
  });

  test.each([
    ['plain http', 'http://push.example.com/send/a'],
    ['an IPv4 literal', 'https://169.254.169.254/latest/meta-data'],
    ['an IPv6 literal', 'https://[::1]/send/a'],
    ['an explicit port', 'https://push.example.com:8080/send/a'],
    ['a bare hostname', 'https://localhost/send/a'],
    ['a .internal name', 'https://metadata.internal/send/a'],
    ['credentials in the URL', 'https://user:pw@push.example.com/send/a'],
    ['not a URL at all', 'not-a-url'],
  ])('refuses %s as an endpoint', async (_label, endpoint) => {
    const f = fixture();
    const res = await f.route(post('/api/push/subscribe', f.ownerCookie, subscribeBody(endpoint)), '1.1.1.1');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_endpoint' });
    expect(f.repos.listPushSubscriptions(f.owner.id).length).toBe(0);
  });

  test.each([
    ['a compressed point', Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 1)]).toString('base64url'), AUTH],
    ['a short point', Buffer.alloc(32, 1).toString('base64url'), AUTH],
    ['a short auth secret', P256DH, Buffer.alloc(8, 1).toString('base64url')],
  ])('refuses %s', async (_label, p256dh, auth) => {
    const f = fixture();
    const res = await f.route(post('/api/push/subscribe', f.ownerCookie, { endpoint: ENDPOINT, keys: { p256dh, auth } }), '1.1.1.1');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_keys' });
  });

  test('refuses a body with no keys at all', async () => {
    const f = fixture();
    const res = await f.route(post('/api/push/subscribe', f.ownerCookie, { endpoint: ENDPOINT }), '1.1.1.1');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  test('stops at the per-user cap rather than growing the table forever', async () => {
    const f = fixture();
    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_USER; i++) {
      const res = await f.route(
        post('/api/push/subscribe', f.ownerCookie, subscribeBody(`https://push.example.com/send/${i}`)),
        '1.1.1.1',
      );
      expect(res.status).toBe(204);
    }
    const overflow = await f.route(
      post('/api/push/subscribe', f.ownerCookie, subscribeBody('https://push.example.com/send/one-too-many')),
      '1.1.1.1',
    );
    expect(overflow.status).toBe(409);
    expect(await overflow.json()).toEqual({ error: 'too_many_subscriptions' });
    expect(f.repos.listPushSubscriptions(f.owner.id).length).toBe(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
  });
});

describe('POST /api/push/unsubscribe', () => {
  test('needs a session', async () => {
    const f = fixture();
    expect((await f.route(post('/api/push/unsubscribe', null, { endpoint: ENDPOINT }), '1.1.1.1')).status).toBe(401);
  });

  test('removes the subscription and tells the gateway', async () => {
    const f = fixture();
    await f.route(post('/api/push/subscribe', f.ownerCookie, subscribeBody()), '1.1.1.1');
    f.changed.length = 0;

    const res = await f.route(post('/api/push/unsubscribe', f.ownerCookie, { endpoint: ENDPOINT }), '1.1.1.1');
    expect(res.status).toBe(204);
    expect(f.repos.listPushSubscriptions(f.owner.id).length).toBe(0);
    expect(f.changed).toEqual([f.owner.id]);
  });

  test('cannot unsubscribe an endpoint registered to someone else', async () => {
    const f = fixture();
    await f.route(post('/api/push/subscribe', f.ownerCookie, subscribeBody()), '1.1.1.1');
    f.changed.length = 0;

    const res = await f.route(post('/api/push/unsubscribe', f.otherCookie, { endpoint: ENDPOINT }), '1.1.1.1');
    // 204 regardless: telling the caller it exists would confirm that this
    // endpoint belongs to some other account.
    expect(res.status).toBe(204);
    expect(f.repos.listPushSubscriptions(f.owner.id).length).toBe(1);
    expect(f.changed).toEqual([]);
  });

  test('an unknown endpoint is a quiet success', async () => {
    const f = fixture();
    const res = await f.route(post('/api/push/unsubscribe', f.ownerCookie, { endpoint: ENDPOINT }), '1.1.1.1');
    expect(res.status).toBe(204);
    expect(f.changed).toEqual([]);
  });

  test('refuses a body with no endpoint', async () => {
    const f = fixture();
    const res = await f.route(post('/api/push/unsubscribe', f.ownerCookie, {}), '1.1.1.1');
    expect(res.status).toBe(400);
  });
});

describe('rate limits', () => {
  /** Charge one bucket until it refuses, and report how many got through. */
  async function drain(route: ReturnType<typeof createRouter>, make: () => Request, ip: string): Promise<number> {
    let allowed = 0;
    for (let i = 0; i < 200; i++) {
      const res = await route(make(), ip);
      if (res.status === 429) return allowed;
      allowed += 1;
    }
    throw new Error('the bucket never refused');
  }

  test('subscribe and unsubscribe share one bucket, per address', async () => {
    const limiter = createRateLimiter();
    const f = fixture({ rateLimiter: limiter });
    const allowed = await drain(f.route, () => post('/api/push/subscribe', f.ownerCookie, subscribeBody()), '9.9.9.9');
    expect(allowed).toBeGreaterThan(0);

    // Same bucket: the limit is on the pair of routes, not on each.
    const after = await f.route(post('/api/push/unsubscribe', f.ownerCookie, { endpoint: ENDPOINT }), '9.9.9.9');
    expect(after.status).toBe(429);
    expect(after.headers.get('retry-after')).toBeTruthy();

    // A different caller is unaffected.
    const elsewhere = await f.route(post('/api/push/unsubscribe', f.ownerCookie, { endpoint: ENDPOINT }), '8.8.8.8');
    expect(elsewhere.status).toBe(204);
  });

  test('the key route is limited too', async () => {
    const limiter = createRateLimiter();
    const f = fixture({ rateLimiter: limiter });
    const allowed = await drain(f.route, () => get('/api/push/vapid-key', f.ownerCookie), '9.9.9.9');
    expect(allowed).toBeGreaterThan(0);
    expect((await f.route(get('/api/push/vapid-key', f.ownerCookie), '9.9.9.9')).status).toBe(429);
  });

  test('the limit is charged before the session is checked, so it also bounds anonymous callers', async () => {
    const limiter = createRateLimiter();
    const f = fixture({ rateLimiter: limiter });
    const allowed = await drain(f.route, () => post('/api/push/subscribe', null, subscribeBody()), '7.7.7.7');
    expect(allowed).toBeGreaterThan(0);
  });
});
