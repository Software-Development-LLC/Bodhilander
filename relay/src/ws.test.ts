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
  /**
   * Skip forward to the next message of `type`.
   *
   * Position-independent on purpose: the relay gains notifications over time
   * (share:sync now follows agent:ready), and a test that asserts "the third
   * message" breaks on every one of them for no real reason.
   */
  const nextOfType = async (type: string) => {
    for (;;) {
      const m = await next();
      if (m?.type === type) return m;
    }
  };
  return { ws, opened, closed, next, nextOfType };
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
  await c.nextOfType('agent:ready');
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
      expect((await c.nextOfType('pong')).type).toBe('pong');

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
      expect(await c.nextOfType('pong')).toMatchObject({ type: 'pong' });
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
      const onAgent = await agent.nextOfType('client:open');
      expect(onAgent.type).toBe('client:open');
      expect(onAgent.payload).toBe('handshake-hello');
      const clientId = onAgent.clientId;
      expect((await client.nextOfType('channel:open')).type).toBe('channel:open');

      // agent → client
      agent.ws.send(JSON.stringify({ type: 'to-client', clientId, payload: 'from-server' }));
      const fromAgent = await client.nextOfType('from-agent');
      expect(fromAgent).toMatchObject({ type: 'from-agent', payload: 'from-server' });

      // client → agent
      client.ws.send(JSON.stringify({ type: 'to-agent', payload: 'from-browser' }));
      const fromClient = await agent.nextOfType('from-client');
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
      // The handle specifically, not just the id: the owner's presence
      // surfaces and approval prompt render it, and asserting only `userId`
      // would pass whether or not it is sent — which is exactly how it went
      // missing once already.
      expect(await agent.nextOfType('client:open')).toMatchObject({
        type: 'client:open',
        principal: { userId, githubLogin: 'u', displayName: 'U' },
      });
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

      expect(await agent.nextOfType('client:open')).toMatchObject({ type: 'client:open', principal: { userId: guest.id } });
      expect((await client.nextOfType('channel:open')).type).toBe('channel:open');
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

      expect((await client.nextOfType('share:unsupported')).type).toBe('share:unsupported');

      // And prove by ordering that nothing reached the agent: a later frame
      // from the owner must be the FIRST thing the agent sees.
      const owner = repos.getMachine(machineId)!.user_id;
      const ownerToken = repos.createSession(owner, 3600).token;
      const ownerClient = connect(`ws://127.0.0.1:${server.port}/ws/client`, {
        cookie: `bdl_session=${ownerToken}`,
      });
      await ownerClient.opened;
      ownerClient.ws.send(JSON.stringify({ type: 'client:open', machineId }));
      expect(await agent.nextOfType('client:open')).toMatchObject({ type: 'client:open', principal: { userId: owner } });
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
      expect((await client.nextOfType('channel:open')).type).toBe('channel:open');
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
      expect((await client.nextOfType('agent:offline')).type).toBe('agent:offline');
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
      expect((await client.nextOfType('agent:offline')).type).toBe('agent:offline');
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
      const clientId = (await agentB.nextOfType('client:open')).clientId;
      expect((await clientB.nextOfType('channel:open')).type).toBe('channel:open');

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

describe('share:* messages (M5.2)', () => {
  /** An agent online for `machineId`, plus a guest with a pending grant on it. */
  async function shared(port: number, db: ReturnType<typeof openDb>, repos: Repositories, m: Awaited<ReturnType<typeof registerMachine>>) {
    const agent = await onlineAgent(port, m.pub, m.sign, ['grants:v1']);
    const guest = repos.upsertGithubUser({
      providerUserId: '999',
      displayName: 'Dana',
      login: 'dana-k',
      email: null,
      avatarUrl: null,
    });
    const { code } = repos.createShareInvite({
      machineId: m.machineId,
      expectedGithubLogin: 'dana-k',
      role: 'viewer',
      label: null,
      grantTtlSeconds: 3600,
      inviteTtlSeconds: 3600,
    });
    const redeem = repos.redeemShareInvite(code, guest, crypto.randomUUID());
    if (!redeem.ok) throw new Error('redeem failed');
    void db;
    return { agent, guest, grantId: redeem.grant.id };
  }

  test('agent:ready is followed by share:sync carrying the machine grants', async () => {
    // Closes the split-brain on every reconnect: without it a relay restore
    // leaves ghosts in the owner's settings and a desktop reinstall leaves
    // guests connecting to a DENY_ALL with no explanation.
    const { db, repos } = freshReposWithDb();
    const m = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const { agent, grantId } = await shared(server.port!, db, repos, m);
      // Reconnect and read the sync.
      agent.ws.close();
      const again = await onlineAgent(server.port!, m.pub, m.sign, ['grants:v1']);
      const sync = await again.nextOfType('share:sync');
      expect(sync.grants.map((g: { grantId: string }) => g.grantId)).toEqual([grantId]);
      expect(sync.grants[0]).toMatchObject({ status: 'pending', role: 'viewer', granteeLogin: 'dana-k' });
    } finally {
      db.close();
      server.stop(true);
    }
  });

  test('share:sync never carries the certificate back to the agent', async () => {
    // The agent signed it. Echoing it would put a credential on a wire that
    // does not need to carry one.
    const { db, repos } = freshReposWithDb();
    const m = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const { grantId } = await shared(server.port!, db, repos, m);
      repos.bindGrantCertificate(grantId, 'grant:v1.SECRET.SECRET', Date.now() + 3_600_000);
      const again = await onlineAgent(server.port!, m.pub, m.sign, ['grants:v1']);
      const sync = await again.nextOfType('share:sync');
      expect(JSON.stringify(sync)).not.toContain('SECRET');
    } finally {
      db.close();
      server.stop(true);
    }
  });

  test('share:bind activates the grant so the guest becomes reachable', async () => {
    const { db, repos } = freshReposWithDb();
    const m = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const { agent, guest, grantId } = await shared(server.port!, db, repos, m);
      expect(repos.getMachineAccess(m.machineId, guest.id)).toEqual({ relation: 'none' });

      agent.ws.send(
        JSON.stringify({ type: 'share:bind', grantId, certificate: 'grant:v1.a.b', expiresAt: Date.now() + 3_600_000 }),
      );
      await Bun.sleep(30);
      expect(repos.getMachineAccess(m.machineId, guest.id).relation).toBe('grantee');
    } finally {
      db.close();
      server.stop(true);
    }
  });

  test('an agent cannot bind a grant belonging to another machine', async () => {
    const { db, repos } = freshReposWithDb();
    const a = await registerMachine(repos, 'user-a');
    const b = await registerMachine(repos, 'user-b');
    const server = startServer(repos);
    try {
      const { guest, grantId } = await shared(server.port!, db, repos, b);
      const agentA = await onlineAgent(server.port!, a.pub, a.sign, ['grants:v1']);

      agentA.ws.send(
        JSON.stringify({ type: 'share:bind', grantId, certificate: 'grant:v1.a.b', expiresAt: Date.now() + 3_600_000 }),
      );
      await Bun.sleep(30);
      expect(repos.getMachineAccess(b.machineId, guest.id)).toEqual({ relation: 'none' });
      expect(repos.getGrant(grantId)!.status).toBe('pending');
    } finally {
      db.close();
      server.stop(true);
    }
  });

  test('share:bind with an already-elapsed expiry is refused', async () => {
    const { db, repos } = freshReposWithDb();
    const m = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const { agent, grantId } = await shared(server.port!, db, repos, m);
      agent.ws.send(JSON.stringify({ type: 'share:bind', grantId, certificate: 'grant:v1.a.b', expiresAt: 1 }));
      await Bun.sleep(30);
      expect(repos.getGrant(grantId)!.status).toBe('pending');
    } finally {
      db.close();
      server.stop(true);
    }
  });

  test('share:deny revokes the grant', async () => {
    const { db, repos } = freshReposWithDb();
    const m = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const { agent, grantId } = await shared(server.port!, db, repos, m);
      agent.ws.send(JSON.stringify({ type: 'share:deny', grantId, reason: 'declined' }));
      await Bun.sleep(30);
      expect(repos.getGrant(grantId)!.status).toBe('revoked');
    } finally {
      db.close();
      server.stop(true);
    }
  });

  test('share:reconcile revokes grants the desktop no longer knows about', async () => {
    // The desktop is the authority on revocation. Anything the relay still
    // holds that the agent does not name is a ghost — a relay restore, or a
    // revocation queued while the agent was offline.
    const { db, repos } = freshReposWithDb();
    const m = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const { agent, grantId } = await shared(server.port!, db, repos, m);
      repos.bindGrantCertificate(grantId, 'grant:v1.a.b', Date.now() + 3_600_000);

      agent.ws.send(JSON.stringify({ type: 'share:reconcile', activeGrantIds: [] }));
      await Bun.sleep(30);
      expect(repos.getGrant(grantId)!.status).toBe('revoked');
    } finally {
      db.close();
      server.stop(true);
    }
  });

  test('share:reconcile keeps grants the desktop still names', async () => {
    const { db, repos } = freshReposWithDb();
    const m = await registerMachine(repos);
    const server = startServer(repos);
    try {
      const { agent, grantId } = await shared(server.port!, db, repos, m);
      agent.ws.send(JSON.stringify({ type: 'share:reconcile', activeGrantIds: [grantId] }));
      await Bun.sleep(30);
      expect(repos.getGrant(grantId)!.status).toBe('pending');
    } finally {
      db.close();
      server.stop(true);
    }
  });

  test('reconcile cannot reach another machine grants', async () => {
    const { db, repos } = freshReposWithDb();
    const a = await registerMachine(repos, 'user-a');
    const b = await registerMachine(repos, 'user-b');
    const server = startServer(repos);
    try {
      const { grantId } = await shared(server.port!, db, repos, b);
      const agentA = await onlineAgent(server.port!, a.pub, a.sign, ['grants:v1']);
      agentA.ws.send(JSON.stringify({ type: 'share:reconcile', activeGrantIds: [] }));
      await Bun.sleep(30);
      expect(repos.getGrant(grantId)!.status).toBe('pending');
    } finally {
      db.close();
      server.stop(true);
    }
  });

  test('revoking over HTTP cuts the guest socket immediately', async () => {
    // Revocation must not wait for the guest to reconnect.
    const { db, repos } = freshReposWithDb();
    const m = await registerMachine(repos);
    const gateway = createGateway({ repos, logger });
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const path = new URL(req.url).pathname;
        if (path === '/ws') return srv.upgrade(req, { data: newAgentSocketData() }) ? undefined : new Response('x', { status: 426 });
        const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
        const user = token ? repos.getUserBySessionToken(token) : null;
        if (!user) return new Response('unauthorized', { status: 401 });
        return srv.upgrade(req, { data: newClientSocketData(user.id) }) ? undefined : new Response('x', { status: 426 });
      },
      websocket: gateway,
    });
    try {
      const { grantId, guest } = await shared(server.port!, db, repos, m);
      repos.bindGrantCertificate(grantId, 'grant:v1.a.b', Date.now() + 3_600_000);

      const { token } = repos.createSession(guest.id, 3600);
      const client = connect(`ws://127.0.0.1:${server.port}/ws/client`, { cookie: `bdl_session=${token}` });
      await client.opened;
      client.ws.send(JSON.stringify({ type: 'client:open', machineId: m.machineId }));
      await client.nextOfType('channel:open');

      gateway.notifyGrantRevoked(repos.getGrant(grantId)!);
      expect((await client.closed).code).toBe(4403);
    } finally {
      db.close();
      server.stop(true);
    }
  });

  test('a redemption wakes the owner agent with share:pending', async () => {
    const { db, repos } = freshReposWithDb();
    const m = await registerMachine(repos);
    const gateway = createGateway({ repos, logger });
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req, { data: newAgentSocketData() }) ? undefined : new Response('x', { status: 426 });
      },
      websocket: gateway,
    });
    try {
      const agent = await onlineAgent(server.port!, m.pub, m.sign, ['grants:v1']);
      const guest = repos.upsertGithubUser({
        providerUserId: '999',
        displayName: 'Dana',
        login: 'dana-k',
        email: null,
        avatarUrl: null,
      });
      const { code } = repos.createShareInvite({
        machineId: m.machineId,
        expectedGithubLogin: null,
        role: 'viewer',
        label: null,
        grantTtlSeconds: 3600,
        inviteTtlSeconds: 3600,
      });
      const redeem = repos.redeemShareInvite(code, guest, crypto.randomUUID());
      if (!redeem.ok) throw new Error('redeem failed');

      gateway.notifyGrantRedeemed(redeem.grant);
      const pending = await agent.nextOfType('share:pending');
      expect(pending.grants[0]).toMatchObject({ grantId: redeem.grant.id, granteeLogin: 'dana-k', status: 'pending' });
    } finally {
      db.close();
      server.stop(true);
    }
  });
});
