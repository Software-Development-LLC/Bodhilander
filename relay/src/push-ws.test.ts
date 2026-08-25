/**
 * The push half of the WebSocket gateway. What the relay does NOT do is the
 * point. Down: keys to the agent, never the endpoint. Up: a sealed body it
 * cannot read, to a subscription it checked, reaping whatever comes back dead.
 */
import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { createLogger } from './logger';
import { createRepositories, type Repositories } from './repositories';
import { createGateway, newAgentSocketData, MAX_PUSH_ITEMS, PUSH_SENDS_PER_MINUTE } from './ws';
import { buildAgentAuthMessage, CAP_GRANTS_V1, CAP_PUSH_V1 } from './protocol';
import { toArrayBuffer } from './crypto';
import { createRateLimiter } from './rate-limit';
import type { PushDelivery, PushDispatcher } from './push/send';

const logger = createLogger('error');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

/** A dispatcher that records what it was asked to send and answers to script. */
function recordingDispatcher(answer: (endpoint: string) => PushDelivery = () => ({ status: 201, gone: false })) {
  const sent: Array<{ endpoint: string; body: string }> = [];
  const dispatcher: PushDispatcher = {
    async deliver(endpoint, body) {
      sent.push({ endpoint, body: Buffer.from(body).toString('base64') });
      return answer(endpoint);
    },
  };
  return { dispatcher, sent };
}

function startServer(
  repos: Repositories,
  over: { push?: PushDispatcher; rateLimiter?: ReturnType<typeof createRateLimiter> } = {},
) {
  const gateway = createGateway({ repos, logger, push: over.push, rateLimiter: over.rateLimiter });
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === '/ws') {
        if (srv.upgrade(req, { data: newAgentSocketData() })) return undefined;
        return new Response('upgrade required', { status: 426 });
      }
      return new Response('ok');
    },
    websocket: gateway,
  });
  return { server, gateway };
}

function connect(url: string) {
  const ws = new WebSocket(url);
  const queue: any[] = [];
  const waiters: Array<(m: any) => void> = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  };
  const opened = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('ws error'));
  });
  const next = () =>
    new Promise<any>((res) => {
      const m = queue.shift();
      if (m) res(m);
      else waiters.push(res);
    });
  const nextOfType = async (type: string) => {
    for (;;) {
      const m = await next();
      if (m?.type === type) return m;
    }
  };
  /** Whether `type` shows up within `ms`. Used to assert an ABSENCE. */
  const sawWithin = async (type: string, ms: number) => {
    const found = Promise.resolve().then(() => nextOfType(type).then(() => true));
    const timeout = new Promise<boolean>((res) => setTimeout(() => res(false), ms));
    return Promise.race([found, timeout]);
  };
  return { ws, opened, next, nextOfType, sawWithin };
}

async function registerMachine(repos: Repositories, providerUserId = '1') {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const user = repos.upsertGithubUser({
    providerUserId,
    displayName: `U${providerUserId}`,
    login: `u${providerUserId}`,
    email: null,
    avatarUrl: null,
  });
  const claim = repos.claimLinkCode(repos.createLinkCode('m', pub, new Uint8Array(32).fill(1), 600).code, user.id);
  const sign = async (m: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, toArrayBuffer(m)));
  return { pub, sign, machineId: claim.ok ? claim.machine.id : '', userId: user.id };
}

async function onlineAgent(
  // `number | undefined`, because that is how Bun types a served port. Only
  // ever interpolated, so there is nothing to assert away.
  port: number | undefined,
  pub: Uint8Array,
  sign: (m: Uint8Array) => Promise<Uint8Array>,
  caps: string[] = [CAP_GRANTS_V1, CAP_PUSH_V1],
) {
  const c = connect(`ws://127.0.0.1:${port}/ws`);
  await c.opened;
  const challenge = await c.next();
  const sig = await sign(buildAgentAuthMessage(challenge.nonce));
  c.ws.send(JSON.stringify({ type: 'agent:auth', ed25519Pub: b64(pub), signature: b64(sig), caps }));
  await c.nextOfType('agent:ready');
  return c;
}

const P256DH = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url');
const AUTH = Buffer.alloc(16, 3).toString('base64url');

function subscribe(repos: Repositories, userId: string, endpoint: string) {
  const saved = repos.upsertPushSubscription(userId, { endpoint, p256dh: P256DH, auth: AUTH });
  if (!saved) throw new Error('subscription refused');
  return saved.subscription;
}

const sealed = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('push:sync — handing an agent the keys it seals to', () => {
  test('arrives on connect, with the keys and without the endpoint', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    subscribe(repos, m.userId, 'https://push.example.com/send/phone');
    const { server } = startServer(repos);

    const agent = await onlineAgent(server.port, m.pub, m.sign);
    const sync = await agent.nextOfType('push:sync');
    expect(sync.subs.length).toBe(1);
    expect(sync.subs[0].p256dh).toBe(P256DH);
    expect(sync.subs[0].auth).toBe(AUTH);
    // The desktop must not learn which push service its owner reads on.
    expect(JSON.stringify(sync)).not.toContain('push.example.com');
    agent.ws.close();
    server.stop(true);
  });

  test('is withheld from an agent that never advertised push:v1', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    subscribe(repos, m.userId, 'https://push.example.com/send/phone');
    const { server } = startServer(repos);

    const agent = await onlineAgent(server.port, m.pub, m.sign, [CAP_GRANTS_V1]);
    // A build that cannot seal has no use for subscription keys, so it is not
    // given any to hold or log.
    expect(await agent.sawWithin('push:sync', 120)).toBe(false);
    agent.ws.close();
    server.stop(true);
  });

  test('is re-sent when the owner subscribes another device', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    const { server, gateway } = startServer(repos);
    const agent = await onlineAgent(server.port, m.pub, m.sign);
    expect((await agent.nextOfType('push:sync')).subs.length).toBe(0);

    subscribe(repos, m.userId, 'https://push.example.com/send/tablet');
    gateway.notifyPushSubscriptions(m.userId);
    expect((await agent.nextOfType('push:sync')).subs.length).toBe(1);
    agent.ws.close();
    server.stop(true);
  });

  test('carries only the owner’s own subscriptions', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const mine = await registerMachine(repos, '1');
    const theirs = await registerMachine(repos, '2');
    subscribe(repos, mine.userId, 'https://push.example.com/send/mine');
    subscribe(repos, theirs.userId, 'https://push.example.com/send/theirs');
    const { server } = startServer(repos);

    const agent = await onlineAgent(server.port, mine.pub, mine.sign);
    const sync = await agent.nextOfType('push:sync');
    expect(sync.subs.length).toBe(1);
    agent.ws.close();
    server.stop(true);
  });
});

describe('push:send — forwarding a sealed body', () => {
  test('addresses the endpoint the agent was never told', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    const sub = subscribe(repos, m.userId, 'https://push.example.com/send/phone');
    const { dispatcher, sent } = recordingDispatcher();
    const { server } = startServer(repos, { push: dispatcher });

    const agent = await onlineAgent(server.port, m.pub, m.sign);
    await agent.nextOfType('push:sync');
    agent.ws.send(JSON.stringify({ type: 'push:send', items: [{ id: sub.id, body: sealed('ciphertext') }] }));

    await Bun.sleep(60);
    expect(sent).toEqual([{ endpoint: 'https://push.example.com/send/phone', body: sealed('ciphertext') }]);
    agent.ws.close();
    server.stop(true);
  });

  test('refuses a subscription belonging to another account', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const mine = await registerMachine(repos, '1');
    const theirs = await registerMachine(repos, '2');
    const notMine = subscribe(repos, theirs.userId, 'https://push.example.com/send/theirs');
    const { dispatcher, sent } = recordingDispatcher();
    const { server } = startServer(repos, { push: dispatcher });

    const agent = await onlineAgent(server.port, mine.pub, mine.sign);
    agent.ws.send(JSON.stringify({ type: 'push:send', items: [{ id: notMine.id, body: sealed('nope') }] }));

    await Bun.sleep(60);
    expect(sent).toEqual([]);
    expect(repos.getPushSubscription(notMine.id)).not.toBeNull();
    agent.ws.close();
    server.stop(true);
  });

  test('a 410 reaps the subscription and re-syncs the agent', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    const sub = subscribe(repos, m.userId, 'https://push.example.com/send/gone');
    const { dispatcher } = recordingDispatcher(() => ({ status: 410, gone: true }));
    const { server } = startServer(repos, { push: dispatcher });

    const agent = await onlineAgent(server.port, m.pub, m.sign);
    expect((await agent.nextOfType('push:sync')).subs.length).toBe(1);

    agent.ws.send(JSON.stringify({ type: 'push:send', items: [{ id: sub.id, body: sealed('x') }] }));
    const resync = await agent.nextOfType('push:sync');
    expect(resync.subs).toEqual([]);
    expect(repos.getPushSubscription(sub.id)).toBeNull();
    agent.ws.close();
    server.stop(true);
  });

  test('a transient refusal keeps the subscription', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    const sub = subscribe(repos, m.userId, 'https://push.example.com/send/busy');
    const { dispatcher } = recordingDispatcher(() => ({ status: 429, gone: false }));
    const { server } = startServer(repos, { push: dispatcher });

    const agent = await onlineAgent(server.port, m.pub, m.sign);
    agent.ws.send(JSON.stringify({ type: 'push:send', items: [{ id: sub.id, body: sealed('x') }] }));

    await Bun.sleep(60);
    expect(repos.getPushSubscription(sub.id)).not.toBeNull();
    agent.ws.close();
    server.stop(true);
  });

  test('a dispatcher that throws does not take the socket down', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    const sub = subscribe(repos, m.userId, 'https://push.example.com/send/phone');
    const exploding: PushDispatcher = { deliver: () => Promise.reject(new Error('DNS is having a day')) };
    const { server } = startServer(repos, { push: exploding });

    const agent = await onlineAgent(server.port, m.pub, m.sign);
    agent.ws.send(JSON.stringify({ type: 'push:send', items: [{ id: sub.id, body: sealed('x') }] }));
    await Bun.sleep(60);

    // Still alive and still routing.
    agent.ws.send(JSON.stringify({ type: 'ping' }));
    expect((await agent.nextOfType('pong')).type).toBe('pong');
    agent.ws.close();
    server.stop(true);
  });

  test('drops an oversized body and malformed items without dropping the batch', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    const good = subscribe(repos, m.userId, 'https://push.example.com/send/good');
    const big = subscribe(repos, m.userId, 'https://push.example.com/send/big');
    const { dispatcher, sent } = recordingDispatcher();
    const { server } = startServer(repos, { push: dispatcher });

    const agent = await onlineAgent(server.port, m.pub, m.sign);
    agent.ws.send(
      JSON.stringify({
        type: 'push:send',
        items: [
          { id: big.id, body: 'A'.repeat(7000) },
          'not an object',
          { id: good.id },
          { id: good.id, body: sealed('fine') },
        ],
      }),
    );

    await Bun.sleep(60);
    expect(sent).toEqual([{ endpoint: 'https://push.example.com/send/good', body: sealed('fine') }]);
    agent.ws.close();
    server.stop(true);
  });

  test('delivers once per subscription however many times its id is repeated', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    const sub = subscribe(repos, m.userId, 'https://push.example.com/send/phone');
    const { dispatcher, sent } = recordingDispatcher();
    const { server } = startServer(repos, { push: dispatcher });

    const agent = await onlineAgent(server.port, m.pub, m.sign);
    // Otherwise one message is a multiplier: 32 copies of an id the agent chose
    // is 32 POSTs at a single target.
    agent.ws.send(
      JSON.stringify({
        type: 'push:send',
        items: Array.from({ length: MAX_PUSH_ITEMS }, () => ({ id: sub.id, body: sealed('x') })),
      }),
    );

    await Bun.sleep(120);
    expect(sent.length).toBe(1);
    agent.ws.close();
    server.stop(true);
  });

  test('drops items past MAX_PUSH_ITEMS instead of walking the whole list', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    const sub = subscribe(repos, m.userId, 'https://push.example.com/send/phone');
    const { dispatcher, sent } = recordingDispatcher();
    const { server } = startServer(repos, { push: dispatcher });

    const agent = await onlineAgent(server.port, m.pub, m.sign);
    // The only real subscription sits PAST the cap, so a delivery here would
    // mean the slice is not being applied.
    const padding = Array.from({ length: MAX_PUSH_ITEMS }, (_, i) => ({ id: `filler-${i}`, body: sealed('x') }));
    agent.ws.send(
      JSON.stringify({ type: 'push:send', items: [...padding, { id: sub.id, body: sealed('past the cap') }] }),
    );
    await Bun.sleep(120);
    expect(sent).toEqual([]);

    // Positive control: the same item inside the cap does go out.
    agent.ws.send(JSON.stringify({ type: 'push:send', items: [{ id: sub.id, body: sealed('inside') }] }));
    await Bun.sleep(120);
    expect(sent.length).toBe(1);
    agent.ws.close();
    server.stop(true);
  });

  test('tells the agent when it refuses a batch, so the debounce is not burned', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    const sub = subscribe(repos, m.userId, 'https://push.example.com/send/phone');
    const { dispatcher } = recordingDispatcher();
    const { server } = startServer(repos, { push: dispatcher, rateLimiter: createRateLimiter() });

    const agent = await onlineAgent(server.port, m.pub, m.sign);
    for (let i = 0; i < PUSH_SENDS_PER_MINUTE + 1; i++) {
      agent.ws.send(JSON.stringify({ type: 'push:send', items: [{ id: sub.id, body: sealed(`x${i}`) }] }));
    }

    // Silence here spends the agent's 30s window on a notification that never
    // left the relay, so those sessions go quiet until they change state again.
    const nack = await agent.nextOfType('push:throttled');
    expect(nack.retryAfterSeconds).toBeGreaterThan(0);
    agent.ws.close();
    server.stop(true);
  });

  test('is rate limited per machine', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    const sub = subscribe(repos, m.userId, 'https://push.example.com/send/phone');
    const { dispatcher, sent } = recordingDispatcher();
    const { server } = startServer(repos, { push: dispatcher, rateLimiter: createRateLimiter() });

    const agent = await onlineAgent(server.port, m.pub, m.sign);
    for (let i = 0; i < PUSH_SENDS_PER_MINUTE + 5; i++) {
      agent.ws.send(JSON.stringify({ type: 'push:send', items: [{ id: sub.id, body: sealed(`x${i}`) }] }));
    }

    await Bun.sleep(200);
    expect(sent.length).toBe(PUSH_SENDS_PER_MINUTE);
    agent.ws.close();
    server.stop(true);
  });

  test('is ignored entirely when the relay has no push configured', async () => {
    const repos = createRepositories(openDb(':memory:'));
    const m = await registerMachine(repos);
    const sub = subscribe(repos, m.userId, 'https://push.example.com/send/phone');
    const { server } = startServer(repos); // no dispatcher

    const agent = await onlineAgent(server.port, m.pub, m.sign);
    agent.ws.send(JSON.stringify({ type: 'push:send', items: [{ id: sub.id, body: sealed('x') }] }));
    await Bun.sleep(60);

    agent.ws.send(JSON.stringify({ type: 'ping' }));
    expect((await agent.nextOfType('pong')).type).toBe('pong');
    agent.ws.close();
    server.stop(true);
  });
});
