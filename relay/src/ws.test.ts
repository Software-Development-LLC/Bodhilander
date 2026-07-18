import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { createLogger } from './logger';
import { createRepositories, type Repositories } from './repositories';
import { createGateway, newAgentSocketData, newClientSocketData } from './ws';
import { parseCookies, SESSION_COOKIE } from './auth/cookies';
import { buildAgentAuthMessage } from './protocol';
import { toArrayBuffer } from './crypto';

const logger = createLogger('error');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

function startServer(repos: Repositories) {
  const gateway = createGateway({ repos, logger });
  return Bun.serve({
    port: 0,
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      if (path === '/ws') {
        if (srv.upgrade(req, { data: newAgentSocketData() })) return undefined;
        return new Response('upgrade required', { status: 426 });
      }
      if (path === '/ws/client') {
        const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
        const user = token ? repos.getUserBySessionToken(token) : null;
        if (!user) return new Response('unauthorized', { status: 401 });
        if (srv.upgrade(req, { data: newClientSocketData(user.id) })) return undefined;
        return new Response('upgrade required', { status: 426 });
      }
      return new Response('ok');
    },
    websocket: gateway,
  });
}

/** A tiny promise-based WebSocket client with a message queue. */
function connect(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
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
  const closed = new Promise<{ code: number }>((res) => {
    ws.addEventListener('close', (e) => res({ code: (e as CloseEvent).code }));
  });
  const next = () =>
    new Promise<any>((res) => {
      const m = queue.shift();
      if (m) res(m);
      else waiters.push(res);
    });
  return { ws, opened, closed, next };
}

async function registerMachine(repos: Repositories) {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const user = repos.upsertGithubUser({ providerUserId: '1', displayName: 'U', email: null, avatarUrl: null });
  const claim = repos.claimLinkCode(repos.createLinkCode('m', pub, new Uint8Array(32).fill(1), 600).code, user.id);
  const machineId = claim.ok ? claim.machine.id : '';
  const sign = async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, toArrayBuffer(m)));
  return { pub, sign, machineId, userId: user.id };
}

/** Connect an agent and drive it through the handshake to `agent:ready`. */
async function onlineAgent(port: number, pub: Uint8Array, sign: (m: Uint8Array) => Promise<Uint8Array>) {
  const c = connect(`ws://127.0.0.1:${port}/ws`);
  await c.opened;
  const challenge = await c.next();
  const sig = await sign(buildAgentAuthMessage(challenge.nonce));
  c.ws.send(JSON.stringify({ type: 'agent:auth', ed25519Pub: b64(pub), signature: b64(sig) }));
  await c.next(); // agent:ready
  return c;
}

function freshRepos() {
  return createRepositories(openDb(':memory:'));
}

describe('agent WebSocket handshake', () => {
  test('a registered agent signs the challenge, goes online, and heartbeats', async () => {
    const repos = freshRepos();
    const { pub, sign } = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const c = connect(`ws://127.0.0.1:${server.port}/ws`);
      await c.opened;

      const challenge = await c.next();
      expect(challenge.type).toBe('challenge');
      expect(typeof challenge.nonce).toBe('string');

      const sig = await sign(buildAgentAuthMessage(challenge.nonce));
      c.ws.send(JSON.stringify({ type: 'agent:auth', ed25519Pub: b64(pub), signature: b64(sig) }));

      const ready = await c.next();
      expect(ready.type).toBe('agent:ready');
      expect(ready.machineId).toBeTruthy();

      // machine marked online
      const machine = repos.findMachineByEd25519(pub)!;
      expect(machine.last_seen_at).toBeGreaterThan(0);

      c.ws.send(JSON.stringify({ type: 'ping' }));
      expect((await c.next()).type).toBe('pong');

      c.ws.close();
    } finally {
      server.stop(true);
    }
  });

  test('an unregistered identity is closed with 4404', async () => {
    const repos = freshRepos();
    const server = startServer(repos);
    try {
      // A valid keypair, but never linked to any account.
      const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
      const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      const c = connect(`ws://127.0.0.1:${server.port}/ws`);
      await c.opened;
      const challenge = await c.next();
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, toArrayBuffer(buildAgentAuthMessage(challenge.nonce))),
      );
      c.ws.send(JSON.stringify({ type: 'agent:auth', ed25519Pub: b64(pub), signature: b64(sig) }));
      expect((await c.closed).code).toBe(4404);
    } finally {
      server.stop(true);
    }
  });

  test('a bad signature is closed with 4401', async () => {
    const repos = freshRepos();
    const { pub } = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const c = connect(`ws://127.0.0.1:${server.port}/ws`);
      await c.opened;
      await c.next(); // challenge
      const garbage = b64(new Uint8Array(64).fill(1));
      c.ws.send(JSON.stringify({ type: 'agent:auth', ed25519Pub: b64(pub), signature: garbage }));
      expect((await c.closed).code).toBe(4401);
    } finally {
      server.stop(true);
    }
  });
});

describe('client ↔ agent brokering (M3)', () => {
  test('the relay routes opaque frames both ways between a client and its agent', async () => {
    const repos = freshRepos();
    const { pub, sign, machineId, userId } = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const agent = await onlineAgent(server.port!, pub, sign);
      const { token } = repos.createSession(userId, 3600);
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await client.opened;

      // Open the channel; a handshake payload rides along.
      client.ws.send(JSON.stringify({ type: 'client:open', machineId, payload: 'handshake-hello' }));
      const onAgent = await agent.next();
      expect(onAgent.type).toBe('client:open');
      expect(onAgent.payload).toBe('handshake-hello');
      const clientId = onAgent.clientId;
      expect((await client.next()).type).toBe('channel:open');

      // agent → client
      agent.ws.send(JSON.stringify({ type: 'to-client', clientId, payload: 'from-server' }));
      const fromAgent = await client.next();
      expect(fromAgent).toMatchObject({ type: 'from-agent', payload: 'from-server' });

      // client → agent
      client.ws.send(JSON.stringify({ type: 'to-agent', payload: 'from-browser' }));
      const fromClient = await agent.next();
      expect(fromClient).toMatchObject({ type: 'from-client', clientId, payload: 'from-browser' });

      client.ws.close();
      agent.ws.close();
    } finally {
      server.stop(true);
    }
  });

  test('opening a machine you do not own is forbidden (4403)', async () => {
    const repos = freshRepos();
    const { pub, sign, machineId } = await registerMachine(repos);
    const server = startServer(repos);
    try {
      await onlineAgent(server.port!, pub, sign);
      // A different user, not the machine owner.
      const other = repos.upsertGithubUser({ providerUserId: '999', displayName: 'Other', email: null, avatarUrl: null });
      const { token } = repos.createSession(other.id, 3600);
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await client.opened;
      client.ws.send(JSON.stringify({ type: 'client:open', machineId }));
      expect((await client.closed).code).toBe(4403);
    } finally {
      server.stop(true);
    }
  });

  test('opening a machine whose agent is offline reports agent:offline', async () => {
    const repos = freshRepos();
    const { machineId, userId } = await registerMachine(repos); // no agent connected
    const server = startServer(repos);
    try {
      const { token } = repos.createSession(userId, 3600);
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await client.opened;
      client.ws.send(JSON.stringify({ type: 'client:open', machineId }));
      expect((await client.next()).type).toBe('agent:offline');
    } finally {
      server.stop(true);
    }
  });

  test('/ws/client without a session cookie is rejected', async () => {
    const repos = freshRepos();
    const server = startServer(repos);
    try {
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`);
      // No cookie → upgrade refused with 401 → the socket errors/closes, never opens.
      const outcome = await Promise.race([
        client.opened.then(() => 'opened').catch(() => 'closed'),
        client.closed.then(() => 'closed'),
      ]);
      expect(outcome).toBe('closed');
    } finally {
      server.stop(true);
    }
  });
});
