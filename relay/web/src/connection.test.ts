/**
 * Frame routing in `RelayConnection` — the logic that caused a production
 * incident on beta.4.
 *
 * A guest sent one command their role does not allow, the agent replied with a
 * `denied` frame, and this class reported it as the session ending — so the
 * UI told them the owner had revoked their access. Nothing here was tested,
 * which is why it took a human hitting it to find.
 *
 * These drive the REAL `handle()` through a real handshake and real sealed
 * frames rather than testing an extracted helper: the bug was not in a
 * predicate, it was in which branch the frame reached.
 *
 * Run with: bun test relay/web/src/connection.test.ts
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { RelayConnection, isEndingReason, CONNECTION_ENDED, ENDING_REASONS, type ConnState } from './connection';

const subtle = crypto.subtle;
const enc = (s: string) => new TextEncoder().encode(s);
const algo = (a: Record<string, unknown>) => a as unknown as AlgorithmIdentifier;

function toB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function ab(u: Uint8Array): ArrayBuffer {
  const b = new ArrayBuffer(u.byteLength);
  new Uint8Array(b).set(u);
  return b;
}

/**
 * Wait until `predicate` holds rather than for a fixed number of milliseconds.
 * Every assertion below waits on an async settle — a WebCrypto unseal, a state
 * push. The deadline is a backstop, not a wait: it returns as soon as the
 * condition holds, and missing it fails on the assertion that follows, which
 * says far more about what went wrong than a bare timeout would.
 */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(1);
}

/** A stand-in for the browser WebSocket the connection opens. */
class FakeSocket {
  static last: FakeSocket | null = null;
  // `send()` guards on `readyState === WebSocket.OPEN`, so a fake without this
  // constant silently drops every outbound frame — the fake has to match the
  // real API surface the code under test actually reads.
  static readonly OPEN = 1;
  readonly sent: unknown[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
  }
  /** Deliver a frame from the "agent", via the relay's envelope. */
  deliver(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type: 'from-agent', payload }) });
  }
}

const g = globalThis as unknown as { WebSocket: unknown; location?: unknown };
const OriginalWebSocket = g.WebSocket;
const hadLocation = 'location' in g;

beforeEach(() => {
  FakeSocket.last = null;
  g.WebSocket = FakeSocket;
  // The relay tree has no DOM globals; `connect()` builds its URL from
  // `location`, so supply just the two fields it reads.
  if (!hadLocation) g.location = { protocol: 'https:', host: 'relay.test' };
});
afterEach(() => {
  g.WebSocket = OriginalWebSocket;
  if (!hadLocation) delete g.location;
});

interface Session {
  socket: FakeSocket;
  states: { state: ConnState; detail?: string }[];
  messages: { type: string }[];
  refusals: string[];
  /** Seal a frame the way the agent would, on the shared session key. */
  seal(counter: number, value: unknown): Promise<{ n: number; ct: string }>;
}

/**
 * Open a connection and complete a genuine handshake, so everything after it
 * runs through the real decrypt path rather than a stub.
 */
async function connected(): Promise<Session> {
  // The "machine" identity, and the per-channel key it would mint.
  const ed = (await subtle.generateKey(algo({ name: 'Ed25519' }), true, ['sign', 'verify'])) as CryptoKeyPair;
  const edPubB64 = toB64(new Uint8Array(await subtle.exportKey('raw', ed.publicKey)));
  const agentX = (await subtle.generateKey(algo({ name: 'X25519' }), true, ['deriveBits'])) as CryptoKeyPair;
  const agentXPubB64 = toB64(new Uint8Array(await subtle.exportKey('raw', agentX.publicKey)));

  const states: { state: ConnState; detail?: string }[] = [];
  const messages: { type: string }[] = [];
  const refusals: string[] = [];

  const conn = new RelayConnection('machine-1', edPubB64, 'grant:v1.aa.bb');
  conn.onState = (state, detail) => states.push({ state, detail });
  conn.onMessage = (m) => messages.push(m as { type: string });
  conn.onCommandDenied = (command) => refusals.push(command);
  conn.connect();

  const socket = FakeSocket.last!;
  await socket.onopen!();

  const open = socket.sent.find((m) => (m as { type: string }).type === 'client:open') as {
    payload: { clientX25519Pub: string; certificate?: string };
  };
  const clientPubB64 = open.payload.clientX25519Pub;

  // Sign the proof exactly as the agent does.
  const msg = enc(`e2e-handshake:v1\n${clientPubB64}\n${agentXPubB64}`);
  const sig = new Uint8Array(await subtle.sign(algo({ name: 'Ed25519' }), ed.privateKey, ab(msg)));

  socket.deliver({
    type: 'handshake',
    ed25519Pub: edPubB64,
    agentX25519Pub: agentXPubB64,
    signature: toB64(sig),
  });
  // Let the async handshake settle — it is done when the state lands.
  await until(() => states.some((x) => x.state === 'ready'));

  // Mirror the client's key derivation from the agent side.
  const clientPub = await subtle.importKey('raw', ab(fromB64(clientPubB64)), algo({ name: 'X25519' }), false, []);
  const shared = new Uint8Array(
    await subtle.deriveBits(algo({ name: 'X25519', public: clientPub }), agentX.privateKey, 256),
  );
  const hk = await subtle.importKey('raw', ab(shared), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    algo({
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ab(enc('bodhilander-relay-salt:v1')),
      info: ab(enc('bodhilander-relay-e2e:v1')),
    }),
    hk,
    256,
  );
  const key = await subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);

  const nonce = (counter: number) => {
    const n = new Uint8Array(12);
    new DataView(n.buffer).setBigUint64(4, BigInt(counter));
    return n;
  };
  const seal = async (counter: number, value: unknown) => ({
    n: counter,
    ct: toB64(
      new Uint8Array(
        await subtle.encrypt({ name: 'AES-GCM', iv: ab(nonce(counter)) }, key, ab(enc(JSON.stringify(value)))),
      ),
    ),
  });

  return { socket, states, messages, refusals, seal };
}

describe('the handshake still works', () => {
  test('a verified proof reaches ready and carries the certificate', async () => {
    const s = await connected();
    expect(s.states.map((x) => x.state)).toContain('ready');
    const open = s.socket.sent.find((m) => (m as { type: string }).type === 'client:open') as {
      payload: { certificate?: string };
    };
    expect(open.payload.certificate).toBe('grant:v1.aa.bb');
  });
});

describe('a refused command must not end the session', () => {
  test('command:denied routes to onCommandDenied, never to a state change', async () => {
    const s = await connected();
    const before = s.states.length;

    s.socket.deliver(await s.seal(0, { type: 'command:denied', reason: 'not_permitted', command: 'terminal:input' }));
    await until(() => s.refusals.length > 0);

    expect(s.refusals).toEqual(['terminal:input']);
    // No new state at all — the session is untouched.
    expect(s.states.length).toBe(before);
  });

  test('a LEGACY denied/not_permitted is treated as a refusal, not an ending', async () => {
    // This is the exact frame that caused the incident. Agents update on their
    // own schedule, so the client has to keep handling it correctly long after
    // the agent stopped sending it.
    const s = await connected();
    const before = s.states.length;

    s.socket.deliver(await s.seal(0, { type: 'denied', reason: 'not_permitted', command: 'terminal:resize' }));
    await until(() => s.refusals.length > 0);

    expect(s.refusals).toEqual(['terminal:resize']);
    expect(s.states.length).toBe(before);
    expect(s.states.some((x) => x.state === 'denied')).toBe(false);
  });

  test('the connection keeps delivering messages after a refusal', async () => {
    const s = await connected();
    s.socket.deliver(await s.seal(0, { type: 'command:denied', command: 'terminal:input' }));
    s.socket.deliver(await s.seal(1, { type: 'sessions', sessions: [] }));
    await until(() => s.messages.length > 0);

    expect(s.messages.map((m) => m.type)).toEqual(['sessions']);
  });
});

describe('losing access still ends the session', () => {
  test.each([...ENDING_REASONS])('reason %s ends it, with that reason preserved', async (reason) => {
    const s = await connected();
    s.socket.deliver(await s.seal(0, { type: 'denied', reason }));
    await until(() => s.states.some((x) => x.state === 'denied'));

    const denied = s.states.filter((x) => x.state === 'denied');
    expect(denied).toHaveLength(1);
    // The reason must survive: it is what selects the copy the guest reads.
    expect(denied[0]!.detail).toBe(reason);
    expect(s.refusals).toEqual([]);
  });

  test('a denied with NO reason ends the session rather than being swallowed', async () => {
    // Failing the other way would leave a guest watching a channel that is
    // already closed — silence is the worse error.
    const s = await connected();
    s.socket.deliver(await s.seal(0, { type: 'denied' }));
    await until(() => s.states.some((x) => x.state === 'denied'));

    expect(s.states.some((x) => x.state === 'denied')).toBe(true);
    expect(s.refusals).toEqual([]);
  });

  test('an UNSEALED denied before any key means only "not authorized"', async () => {
    // Nothing has authenticated it at that point, so it may say you did not
    // get in — never why.
    const states: { state: ConnState; detail?: string }[] = [];
    const conn = new RelayConnection('machine-1', 'AAAA', null);
    conn.onState = (state, detail) => states.push({ state, detail });
    conn.connect();
    const socket = FakeSocket.last!;
    await socket.onopen!();

    socket.deliver({ type: 'denied', reason: 'revoked' });
    await until(() => states.some((x) => x.state === 'denied'));

    const denied = states.find((x) => x.state === 'denied');
    expect(denied?.detail).toBe('not_authorized');
  });
});

describe('the relay cutting the socket', () => {
  // An HTTP revoke reaches a live guest as a close from the relay itself —
  // the agent never gets a sealed word in first. Without this mapping the
  // guest would sit on a frozen terminal, silently reconnecting forever.
  test('a 4403 close with a known ending reason is terminal — without its story', async () => {
    const s = await connected();
    s.socket.onclose!({ code: 4403, reason: 'revoked' });

    const denied = s.states.filter((x) => x.state === 'denied');
    expect(denied).toHaveLength(1);
    // The unsealed reason must not travel: forwarding it would select the
    // person-attributed "they stopped sharing" copy the sealed path renders.
    expect(denied[0]!.detail).toBe(CONNECTION_ENDED);
    expect(denied[0]!.detail).not.toBe('revoked');
    expect(s.states.some((x) => x.state === 'closed')).toBe(false);
  });

  test('a 4403 with an unknown reason stays a plain close, so it reconnects', async () => {
    const s = await connected();
    s.socket.onclose!({ code: 4403, reason: 'paused' });

    expect(s.states.some((x) => x.state === 'denied')).toBe(false);
    expect(s.states.some((x) => x.state === 'closed')).toBe(true);
  });

  test('an ordinary network drop is still a plain close', async () => {
    const s = await connected();
    s.socket.onclose!({ code: 1006, reason: '' });

    expect(s.states.some((x) => x.state === 'closed')).toBe(true);
    expect(s.states.some((x) => x.state === 'denied')).toBe(false);
  });
});

describe('isEndingReason', () => {
  test('accepts every reason that ends access', () => {
    for (const r of ENDING_REASONS) expect(isEndingReason(r)).toBe(true);
  });

  test('rejects a command refusal and anything unknown', () => {
    expect(isEndingReason('not_permitted')).toBe(false);
    expect(isEndingReason('')).toBe(false);
    expect(isEndingReason('something_new')).toBe(false);
  });
});
