/**
 * The push seam inside `RelayClient` — the part `planAttentionPush` cannot see.
 *
 * Three behaviours the design makes claims about and nothing asserted: that a
 * `push:sync` replaces the subscription list wholesale, that the debounce
 * SURVIVES a reconnect but is cleared by `disable()`, and that a relay refusal
 * hands the spent window back. All were correct by inspection, which is exactly
 * the state a comment can keep looking like long after it stops being true.
 *
 * Run with: bun test --isolate src/main/api/relay/__tests__/relay-client-push.test.ts
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createECDH } from 'crypto';

// --- the module graph relay-client pulls in ------------------------------
//
// Faithful supersets, and no more: each stub exposes the shape relay-client
// actually reaches for. Paths are relative to THIS file, which is a level
// deeper than relay-client.ts. `--isolate` keeps these out of every other
// file, which is what makes mocking this graph acceptable at all.

const prefs = new Map<string, string>();
mock.module('electron', () => ({
  powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => true },
}));
mock.module('electron-log', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
mock.module('../../../repositories/preferences', () => ({
  getPreference: (k: string) => prefs.get(k) ?? null,
  setPreference: (k: string, v: string) => { prefs.set(k, v); },
  deletePreference: (k: string) => { prefs.delete(k); },
}));
mock.module('../../../repositories/sessions', () => ({ getAllSessions: () => [] }));
mock.module('../../../database', () => ({ getDatabase: () => ({}) }));
mock.module('../../../pty-manager', () => ({
  ptyManager: { getSession: () => undefined, scrollbackMark: () => null },
}));
mock.module('../relay-identity', () => ({
  ensureIdentity: () => ({ ed25519Pub: 'ZWQ=', x25519Pub: 'eA==' }),
  identityFingerprint: () => 'fp',
  signWithIdentity: () => Buffer.from('sig'),
}));
mock.module('../session-tunnel', () => ({
  SessionTunnel: class {
    attachedGuests() { return []; }
    closeAll() {}
    revokeGrant() {}
    noteShareMarks() {}
    open() {}
    frame() {}
    closeClient() {}
  },
}));
mock.module('../session-tunnel-deps', () => ({ defaultDeps: () => ({}) }));
mock.module('../grant-store', () => ({
  GRANT_PREF: { ownerUserId: 'relay.ownerUserId' },
  clearAllGrants: () => {},
  clearPendingRevocation: () => {},
  getGrant: () => null,
  getOwnerUserId: () => null,
  listGrants: () => [],
  mintGrant: () => ({ certificate: 'c', grant: { expiresAt: 0 } }),
  pendingRevocations: () => [],
  revokeGrant: () => {},
  setOwnerUserId: () => {},
}));
mock.module('../grant-sql', () => ({ getInviteScope: () => null, recordInviteScope: () => {} }));

/** Sockets this test opened, so each one's traffic can be read back. */
const sockets: FakeSocket[] = [];

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private handlers = new Map<string, (arg?: unknown) => void>();
  constructor() { sockets.push(this); }
  on(event: string, fn: (arg?: unknown) => void) { this.handlers.set(event, fn); return this; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; }
  removeAllListeners() { this.handlers.clear(); }
  /** Push a relay→agent frame at the client. */
  deliver(msg: unknown) { this.handlers.get('message')?.(Buffer.from(JSON.stringify(msg))); }
  /** Drop the socket from the relay's end, running the client's teardown. */
  dropRemote(code = 1006) { this.readyState = 3; this.handlers.get('close')?.(code); }
  messages(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}
mock.module('ws', () => ({ WebSocket: FakeSocket }));

const { RelayClient } = await import('../relay-client');

afterAll(() => {
  mock.restore();
});

/** A subscription with a real P-256 key, so sealing actually succeeds. */
function subscription(id: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { id, p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 4).toString('base64url') };
}

/** Drive a fresh socket through the handshake and return it. */
function handshake(client: { startIfEnabled(): void }) {
  client.startIfEnabled();
  const socket = sockets[sockets.length - 1]!;
  socket.deliver({ type: 'challenge', nonce: 'n' });
  socket.deliver({ type: 'agent:ready', machineId: 'machine-1', owner: null });
  socket.sent.length = 0;
  return socket;
}

/** An enabled, linked, connected client with one live socket. */
function onlineClient() {
  prefs.clear();
  prefs.set('relay.enabled', 'true');
  prefs.set('relay.url', 'https://relay.test');
  sockets.length = 0;

  const client = new RelayClient();
  client.startIfEnabled();
  const socket = sockets[sockets.length - 1]!;
  socket.deliver({ type: 'challenge', nonce: 'n' });
  socket.deliver({ type: 'agent:ready', machineId: 'machine-1', owner: null });
  socket.sent.length = 0;
  return { client, socket };
}

const EVENT = { sessionId: 's-1', sessionName: 'deploy-prod', state: 'waiting' as const };

function pushSends(socket: FakeSocket) {
  return socket.messages().filter((m) => m.type === 'push:send');
}

describe('agent:auth', () => {
  test('advertises push:v1, or the relay withholds the keys it needs', () => {
    prefs.clear();
    prefs.set('relay.enabled', 'true');
    sockets.length = 0;
    const client = new RelayClient();
    client.startIfEnabled();
    const socket = sockets[sockets.length - 1]!;
    socket.deliver({ type: 'challenge', nonce: 'n' });

    const auth = socket.messages().find((m) => m.type === 'agent:auth')!;
    expect(auth.caps).toEqual(['grants:v1', 'push:v1']);
    client.stop();
  });
});

describe('push:sync', () => {
  test('is adopted, and a later one REPLACES it rather than merging', () => {
    const { client, socket } = onlineClient();
    const phone = subscription('phone');
    const tablet = subscription('tablet');

    socket.deliver({ type: 'push:sync', subs: [phone, tablet] });
    client.notifyAttention(EVENT);
    expect((pushSends(socket)[0]!.items as unknown[]).length).toBe(2);

    // The owner turned one device off. A merge here would resurrect it — the
    // relay is where every subscription change lands, so its list is the list.
    socket.sent.length = 0;
    socket.deliver({ type: 'push:sync', subs: [phone] });
    client.notifyAttention({ ...EVENT, sessionId: 's-2' });
    const items = pushSends(socket)[0]!.items as Array<{ id: string }>;
    expect(items.map((i) => i.id)).toEqual(['phone']);
    client.stop();
  });

  test('an emptied list means nothing is sent at all', () => {
    const { client, socket } = onlineClient();
    socket.deliver({ type: 'push:sync', subs: [subscription('phone')] });
    socket.deliver({ type: 'push:sync', subs: [] });
    socket.sent.length = 0;

    client.notifyAttention(EVENT);
    expect(pushSends(socket)).toEqual([]);
    client.stop();
  });

  test('ignores malformed entries instead of sealing to them', () => {
    const { client, socket } = onlineClient();
    socket.deliver({
      type: 'push:sync',
      subs: [subscription('good'), { id: 'no-keys' }, null, { p256dh: 'x', auth: 'y' }],
    });
    socket.sent.length = 0;

    client.notifyAttention(EVENT);
    const items = pushSends(socket)[0]!.items as Array<{ id: string }>;
    expect(items.map((i) => i.id)).toEqual(['good']);
    client.stop();
  });
});

describe('notifyAttention', () => {
  test('sends nothing before the relay has said which browsers are subscribed', () => {
    const { client, socket } = onlineClient();
    client.notifyAttention(EVENT);
    expect(pushSends(socket)).toEqual([]);
    client.stop();
  });

  test('never puts the session name on the wire', () => {
    const { client, socket } = onlineClient();
    socket.deliver({ type: 'push:sync', subs: [subscription('phone')] });
    socket.sent.length = 0;

    client.notifyAttention({ sessionId: 's-9', sessionName: 'top-secret-project', state: 'waiting' });
    expect(socket.sent.join('')).not.toContain('top-secret-project');
    client.stop();
  });

  test('debounces a flapping session', () => {
    const { client, socket } = onlineClient();
    socket.deliver({ type: 'push:sync', subs: [subscription('phone')] });
    socket.sent.length = 0;

    for (let i = 0; i < 5; i++) client.notifyAttention(EVENT);
    expect(pushSends(socket).length).toBe(1);
    client.stop();
  });
});

describe('the debounce across a connection lifetime', () => {
  test('SURVIVES a reconnect — the moment a reset would let the storm through', () => {
    const { client, socket } = onlineClient();
    socket.deliver({ type: 'push:sync', subs: [subscription('phone')] });
    client.notifyAttention(EVENT);
    expect(pushSends(socket).length).toBe(1);

    // A genuine drop: the close handler runs, which is where teardown lives.
    socket.dropRemote();
    const reconnected = handshake(client);
    expect(reconnected).not.toBe(socket);
    reconnected.deliver({ type: 'push:sync', subs: [subscription('phone')] });
    reconnected.sent.length = 0;

    // Still inside the 30s window. A socket bouncing mid-flap is exactly when
    // resetting the debounce would let the storm through.
    client.notifyAttention(EVENT);
    expect(pushSends(reconnected)).toEqual([]);
    client.stop();
  });

  test('is cleared by disable(), which is a decision rather than a blip', () => {
    const { client, socket } = onlineClient();
    socket.deliver({ type: 'push:sync', subs: [subscription('phone')] });
    client.notifyAttention(EVENT);

    client.disable();
    prefs.set('relay.enabled', 'true');
    const next = handshake(client);
    next.deliver({ type: 'push:sync', subs: [subscription('phone')] });
    next.sent.length = 0;

    // Turning remote hosting off and on again is someone asking for a clean
    // slate, so the same event notifies rather than being suppressed.
    client.notifyAttention(EVENT);
    expect(pushSends(next).length).toBe(1);
    client.stop();
  });

  test('subscription keys do NOT survive a teardown', () => {
    const { client, socket } = onlineClient();
    socket.deliver({ type: 'push:sync', subs: [subscription('phone')] });

    socket.dropRemote();
    const reconnected = handshake(client);
    // Deliberately no push:sync this time — the relay has not spoken yet.
    // A revocation heard while we were away must not be actionable from a
    // list we kept, so nothing may be sealed until it re-states one.
    client.notifyAttention({ ...EVENT, sessionId: 'never-notified-before' });
    expect(pushSends(reconnected)).toEqual([]);
    client.stop();
  });
});

describe('push:throttled', () => {
  test('hands the debounce window back, so the next change notifies', () => {
    const { client, socket } = onlineClient();
    socket.deliver({ type: 'push:sync', subs: [subscription('phone')] });
    socket.sent.length = 0;

    client.notifyAttention(EVENT);
    expect(pushSends(socket).length).toBe(1);
    // Refused: nothing was delivered, so the window it cost must be returned —
    // otherwise that session stays silent until it changes state again.
    socket.deliver({ type: 'push:throttled', retryAfterSeconds: 42 });

    client.notifyAttention(EVENT);
    expect(pushSends(socket).length).toBe(2);
    client.stop();
  });

  test('gives back only the window it actually spent', () => {
    const { client, socket } = onlineClient();
    socket.deliver({ type: 'push:sync', subs: [subscription('phone')] });
    socket.sent.length = 0;

    client.notifyAttention({ ...EVENT, sessionId: 'a' });
    client.notifyAttention({ ...EVENT, sessionId: 'b' });
    socket.deliver({ type: 'push:throttled' });

    socket.sent.length = 0;
    client.notifyAttention({ ...EVENT, sessionId: 'b' }); // reopened
    client.notifyAttention({ ...EVENT, sessionId: 'a' }); // still debounced
    const items = pushSends(socket);
    expect(items.length).toBe(1);
    client.stop();
  });
});

beforeEach(() => {
  sockets.length = 0;
});
