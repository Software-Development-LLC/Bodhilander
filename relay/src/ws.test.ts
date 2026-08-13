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

function startServer(repos: Repositories, authTimeoutMs?: number) {
  const gateway = createGateway({ repos, logger, authTimeoutMs });
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

async function registerMachine(repos: Repositories, providerUserId = '1') {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const user = repos.upsertGithubUser({ providerUserId, displayName: 'U', login: 'u', email: null, avatarUrl: null });
  const claim = repos.claimLinkCode(repos.createLinkCode('m', pub, new Uint8Array(32).fill(1), 600).code, user.id);
  const machineId = claim.ok ? claim.machine.id : '';
  const sign = async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, toArrayBuffer(m)));
  return { pub, sign, machineId, userId: user.id };
}

/** Connect an agent and drive it through the handshake to `agent:ready`. */
async function onlineAgent(
  port: number,
  pub: Uint8Array,
  sign: (m: Uint8Array) => Promise<Uint8Array>,
  caps?: string[],
) {
  const c = connect(`ws://127.0.0.1:${port}/ws`);
  await c.opened;
  const challenge = await c.next();
  const sig = await sign(buildAgentAuthMessage(challenge.nonce));
  const auth: Record<string, unknown> = { type: 'agent:auth', ed25519Pub: b64(pub), signature: b64(sig) };
  if (caps) auth.caps = caps;
  c.ws.send(JSON.stringify(auth));
  await c.next(); // agent:ready
  return c;
}

function freshRepos() {
  return createRepositories(openDb(':memory:'));
}

/** Repos plus the raw db, for tests that need to seed a grant directly. */
function freshReposWithDb() {
  const db = openDb(':memory:');
  return { db, repos: createRepositories(db) };
}

/**
 * Give `userId` an active, countersigned grant on `machineId`.
 *
 * Written with SQL rather than a repository method on purpose: the grant write
 * path arrives with M5.2 (invite redemption is what creates one), and adding
 * it now would leave an unreachable method on the interface.
 */
function seedGrant(db: ReturnType<typeof openDb>, machineId: string, granteeUserId: string): string {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO machine_grants
       (id, machine_id, grantee_user_id, certificate, role, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'viewer', 'active', ?, ?)`,
  ).run(id, machineId, granteeUserId, 'grant:v1.x.y', Date.now(), Date.now() + 3_600_000);
  return id;
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

  test('a socket that never answers the challenge is closed when the timeout elapses', async () => {
    // The reaper itself, not just the timer field: an unauthenticated socket
    // holds a connection slot and nothing can ever be routed over it.
    const repos = freshRepos();
    const server = startServer(repos, 50);
    try {
      const c = connect(`ws://127.0.0.1:${server.port}/ws`);
      await c.opened;
      await c.next(); // challenge — then say nothing at all
      expect((await c.closed).code).toBe(4401);
    } finally {
      server.stop(true);
    }
  });

  test('answering the challenge disarms the reaper', async () => {
    // The mirror of the test above: with a 50ms timeout, an authenticated
    // socket that stays quiet well past it must still be alive. Without the
    // clearTimeout in the auth path this fails.
    const repos = freshRepos();
    const { pub, sign, machineId } = await registerMachine(repos);
    const server = startServer(repos, 50);
    try {
      const c = connect(`ws://127.0.0.1:${server.port}/ws`);
      await c.opened;
      const challenge = await c.next();
      const sig = await sign(buildAgentAuthMessage(challenge.nonce));
      c.ws.send(JSON.stringify({ type: 'agent:auth', ed25519Pub: b64(pub), signature: b64(sig) }));
      expect(await c.next()).toMatchObject({ type: 'agent:ready', machineId });

      // Prove liveness after the window rather than sleeping blind: a ping
      // round-trip that completes can only happen on an open socket.
      await Bun.sleep(120);
      c.ws.send(JSON.stringify({ type: 'ping' }));
      expect(await c.next()).toMatchObject({ type: 'pong' });
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
      const other = repos.upsertGithubUser({ providerUserId: '999', displayName: 'Other', login: 'other', email: null, avatarUrl: null });
      const { token } = repos.createSession(other.id, 3600);
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await client.opened;
      client.ws.send(JSON.stringify({ type: 'client:open', machineId }));
      expect((await client.closed).code).toBe(4403);
    } finally {
      server.stop(true);
    }
  });

  test('client:open carries a relay-asserted principal', async () => {
    const repos = freshRepos();
    const { pub, sign, machineId, userId } = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const agent = await onlineAgent(server.port!, pub, sign, ['grants:v1']);
      const { token } = repos.createSession(userId, 3600);
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await client.opened;
      client.ws.send(JSON.stringify({ type: 'client:open', machineId }));

      // The agent checks a certificate against this; it is never authorization
      // on its own, which is why the field is named `principal`.
      expect(await agent.next()).toMatchObject({ type: 'client:open', principal: { userId } });
    } finally {
      server.stop(true);
    }
  });

  test('a grantee reaches a machine they do not own when the agent enforces grants', async () => {
    const { db, repos } = freshReposWithDb();
    const { pub, sign, machineId } = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const agent = await onlineAgent(server.port!, pub, sign, ['grants:v1']);
      const guest = repos.upsertGithubUser({ providerUserId: '999', displayName: 'G', login: 'g', email: null, avatarUrl: null });
      seedGrant(db, machineId, guest.id);
      const { token } = repos.createSession(guest.id, 3600);
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await client.opened;
      client.ws.send(JSON.stringify({ type: 'client:open', machineId }));

      expect(await agent.next()).toMatchObject({ type: 'client:open', principal: { userId: guest.id } });
      expect((await client.next()).type).toBe('channel:open');
    } finally {
      db.close();
      server.stop(true);
    }
  });

  test('a grantee is refused when the live agent has not advertised grants:v1', async () => {
    // The version-skew guard. A desktop build older than grant enforcement
    // reads only `clientX25519Pub` from this payload and ignores the rest, so
    // routing a guest to it would hand over every command on a machine whose
    // owner never opted into sharing. The relay redeploys independently of
    // shipped Electron builds, so this is the normal case for a while.
    const { db, repos } = freshReposWithDb();
    const { pub, sign, machineId } = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const agent = await onlineAgent(server.port!, pub, sign); // no caps — an old build
      const guest = repos.upsertGithubUser({ providerUserId: '999', displayName: 'G', login: 'g', email: null, avatarUrl: null });
      seedGrant(db, machineId, guest.id);
      const { token } = repos.createSession(guest.id, 3600);
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await client.opened;
      client.ws.send(JSON.stringify({ type: 'client:open', machineId }));

      expect((await client.next()).type).toBe('share:unsupported');

      // And prove by ordering that nothing reached the agent: a later frame
      // from the owner must be the FIRST thing the agent sees.
      const owner = repos.getMachine(machineId)!.user_id;
      const ownerToken = repos.createSession(owner, 3600).token;
      const ownerClient = connect(`ws://127.0.0.1:${server.port}/ws/client`, {
        cookie: `bdl_session=${ownerToken}`,
      });
      await ownerClient.opened;
      ownerClient.ws.send(JSON.stringify({ type: 'client:open', machineId }));
      expect(await agent.next()).toMatchObject({ type: 'client:open', principal: { userId: owner } });
    } finally {
      db.close();
      server.stop(true);
    }
  });

  test('the owner still connects to an agent that has not advertised grants:v1', async () => {
    // The gate is for guests only — it must not lock owners out of their own
    // machine while agents are still updating.
    const repos = freshRepos();
    const { pub, sign, machineId, userId } = await registerMachine(repos);
    const server = startServer(repos);
    try {
      await onlineAgent(server.port!, pub, sign); // no caps
      const { token } = repos.createSession(userId, 3600);
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await client.opened;
      client.ws.send(JSON.stringify({ type: 'client:open', machineId }));
      expect((await client.next()).type).toBe('channel:open');
    } finally {
      server.stop(true);
    }
  });

  test('caps are only believed after the signature checks out', async () => {
    // An unauthenticated socket must not be able to claim grants:v1 for a
    // machine it does not control.
    const { db, repos } = freshReposWithDb();
    const { pub, machineId } = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const c = connect(`ws://127.0.0.1:${server.port}/ws`);
      await c.opened;
      await c.next(); // challenge
      // Claim caps with a bad signature: the socket is closed, not trusted.
      c.ws.send(
        JSON.stringify({
          type: 'agent:auth',
          ed25519Pub: b64(pub),
          signature: b64(new Uint8Array(64).fill(1)),
          caps: ['grants:v1'],
        }),
      );
      expect((await c.closed).code).toBe(4401);

      // The claim left nothing behind: with no authenticated agent, a guest
      // gets agent:offline rather than a channel.
      const guest = repos.upsertGithubUser({ providerUserId: '999', displayName: 'G', login: 'g', email: null, avatarUrl: null });
      seedGrant(db, machineId, guest.id);
      const { token } = repos.createSession(guest.id, 3600);
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await client.opened;
      client.ws.send(JSON.stringify({ type: 'client:open', machineId }));
      expect((await client.next()).type).toBe('agent:offline');
    } finally {
      db.close();
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

  test('an agent cannot push frames into another machine\'s client channel', async () => {
    const repos = freshRepos();
    const a = await registerMachine(repos, 'user-a');
    const b = await registerMachine(repos, 'user-b');
    const server = startServer(repos);
    try {
      const agentA = await onlineAgent(server.port!, a.pub, a.sign);
      const agentB = await onlineAgent(server.port!, b.pub, b.sign);

      const { token } = repos.createSession(b.userId, 3600);
      const clientB = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await clientB.opened;
      clientB.ws.send(JSON.stringify({ type: 'client:open', machineId: b.machineId }));
      const clientId = (await agentB.next()).clientId;
      expect((await clientB.next()).type).toBe('channel:open');

      // Agent A names a client id that belongs to machine B's channel.
      agentA.ws.send(JSON.stringify({ type: 'to-client', clientId, payload: 'injected' }));
      // ...then B's own agent sends a legitimate frame. Both traverse the same
      // server, so if the injection were routed it would arrive first.
      agentB.ws.send(JSON.stringify({ type: 'to-client', clientId, payload: 'legitimate' }));

      expect(await clientB.next()).toMatchObject({ type: 'from-agent', payload: 'legitimate' });

      clientB.ws.close();
      agentA.ws.close();
      agentB.ws.close();
    } finally {
      server.stop(true);
    }
  });

  test('a second client:open on the same socket is refused (4400)', async () => {
    const repos = freshRepos();
    const { pub, sign, machineId, userId } = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const agent = await onlineAgent(server.port!, pub, sign);
      const { token } = repos.createSession(userId, 3600);
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await client.opened;

      client.ws.send(JSON.stringify({ type: 'client:open', machineId }));
      await agent.next();
      expect((await client.next()).type).toBe('channel:open');

      // Re-opening would strand the agent's state for this client id.
      client.ws.send(JSON.stringify({ type: 'client:open', machineId }));
      expect((await client.closed).code).toBe(4400);

      agent.ws.close();
    } finally {
      server.stop(true);
    }
  });

  test('a client ping is answered with a pong (browser keepalive)', async () => {
    const repos = freshRepos();
    const { userId } = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const { token } = repos.createSession(userId, 3600);
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await client.opened;

      client.ws.send(JSON.stringify({ type: 'ping' }));
      expect((await client.next()).type).toBe('pong');

      client.ws.close();
    } finally {
      server.stop(true);
    }
  });

  test('reconnecting an agent closes the socket it replaces', async () => {
    const repos = freshRepos();
    const { pub, sign } = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const first = await onlineAgent(server.port!, pub, sign);
      const second = await onlineAgent(server.port!, pub, sign);

      // The stale socket is closed rather than silently dropped from the table.
      expect((await first.closed).code).toBe(4409);

      second.ws.close();
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
