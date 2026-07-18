import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { createLogger } from './logger';
import { createRepositories, type Repositories } from './repositories';
import { createAgentGateway, newAgentSocketData } from './ws';
import { buildAgentAuthMessage } from './protocol';
import { toArrayBuffer } from './crypto';

const logger = createLogger('error');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

function startServer(repos: Repositories) {
  const gateway = createAgentGateway({ repos, logger });
  return Bun.serve({
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
}

/** A tiny promise-based WebSocket client with a message queue. */
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
  repos.claimLinkCode(repos.createLinkCode('m', pub, new Uint8Array(32).fill(1), 600).code, user.id);
  const sign = async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, toArrayBuffer(m)));
  return { pub, sign };
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
