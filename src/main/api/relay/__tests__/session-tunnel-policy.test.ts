/**
 * Deny-path tests for the tunnel's authorization gate.
 *
 * These are the tests the DI refactor exists for — and note what is NOT here:
 * no `mock.module()` at all. `session-tunnel.ts` imports nothing from
 * Electron, so its dependencies are supplied as plain fakes. bun's
 * `mock.module()` is process-wide, so stubbing `ptyManager` to reach this code
 * would have broken `pty-manager.test.ts` depending on which file loaded
 * first; the refactor removes the need rather than working around it.
 *
 * What is deliberately NOT faked is `dispatch()` itself. Testing an extracted
 * policy module proves the table is right but not that the tunnel consults it,
 * and "the gate exists but nothing calls it" is precisely the bug class this
 * feature must not ship.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { SessionTunnel } from '../session-tunnel';
import type {
  GuestResizeRequest,
  Principal,
  TunnelDeps,
  TunnelSessionRow,
  TunnelGroupRow,
  TunnelStoredGrant,
} from '../session-tunnel';
import { deriveSessionKey, sealJson, openJson, buildHandshakeProof } from '../e2e';
import { COMMAND_CAPS } from '../grants';

type SessionTunnelType = InstanceType<typeof SessionTunnel>;

const MACHINE_ID = 'machine-1';
const RELAY_ORIGIN = 'https://relay.example.com';
const OWNER_ID = 'owner-user';
const GUEST_ID = 'guest-user';
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

// The machine identity the fake identity port serves.
const machineKeys = crypto.generateKeyPairSync('ed25519');
const MACHINE_PUB_B64 = Buffer.from(
  (machineKeys.publicKey.export({ format: 'jwk' }) as { x: string }).x,
  'base64url',
).toString('base64');

interface Harness {
  tunnel: SessionTunnelType;
  sent: { clientId: string; payload: unknown }[];
  deps: TunnelDeps;
  /** Represent output arriving on a session. */
  append(sessionId: string, data: string): void;
  /** The mark the approval flow would capture right now. */
  markNow(sessionId: string): number;
  /** The client public key most recently offered, for proof assertions. */
  lastClientPub: string | null;
  /** Client-side key material, so tests can read what the tunnel sealed. */
  openChannel(clientId: string, opts?: { principal?: Principal; certificate?: string }): Buffer | null;
  send(clientId: string, key: Buffer, n: number, obj: unknown): void;
  opened(clientId: string, key: Buffer): { type?: string; [k: string]: unknown }[];
}

const SESSIONS: TunnelSessionRow[] = [
  { id: 's1', name: 'Shared', state: 'idle', groupId: 'g1', workingDir: '/home/will/secret-project' },
  { id: 's2', name: 'Private', state: 'idle', groupId: 'g2', workingDir: '/home/will/other' },
];
const GROUPS: TunnelGroupRow[] = [
  { id: 'g1', name: 'One', color: '#fff', workingDir: '/home/will/secret-project', parentId: null },
  { id: 'g2', name: 'Two', color: '#000', workingDir: '/home/will/other', parentId: null },
];

function harness(over: Partial<TunnelDeps> & { grantRow?: TunnelStoredGrant | null } = {}): Harness {
  const sent: { clientId: string; payload: unknown }[] = [];
  // What each session has produced so far. Tests append to it to represent
  // output arriving while a guest is attached, or away.
  const stream = new Map<string, string>([
    ['s1', 'BEFORE THE SHARE'],
    ['s2', ''],
  ]);
  const epochs = new Map<string, number>([
    ['s1', 111],
    ['s2', 222],
  ]);
  let latched = false;

  const deps: TunnelDeps = {
    pty: {
      subscribe: () => () => {},
      write: () => {},
      resize: () => {},
      getSize: () => ({ cols: 80, rows: 24 }),
      isLive: (id) => epochs.has(id),
      ptyEpoch: (id) => epochs.get(id) ?? null,
      getSerializedBuffer: async () => 'OWNER SCROLLBACK',
      // A stand-in for the PTY's output stream: a mark is a length, and
      // "since" is the tail past it — the same contract `PtyManager` honours
      // through its evict-aware counter.
      scrollbackMark: (id) => (epochs.has(id) ? (stream.get(id) ?? '').length : null),
      getSerializedBufferSince: async (id, mark) => (stream.get(id) ?? '').slice(mark),
    },
    sessions: { getAll: () => SESSIONS },
    groups: { getAll: () => GROUPS },
    grants: {
      get: () => over.grantRow ?? null,
      ownerUserId: () => OWNER_ID,
      enforced: () => latched,
      latch: () => {
        latched = true;
      },
    },
    remote: { createSession: () => {}, createGroup: () => {} },
    identity: {
      ed25519Pub: () => MACHINE_PUB_B64,
      sign: (message) => crypto.sign(null, Buffer.from(message), machineKeys.privateKey),
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    relayOrigin: () => RELAY_ORIGIN,
    machineId: () => MACHINE_ID,
    now: () => NOW,
    ...over,
  };

  const tunnel = new SessionTunnel((clientId, payload) => sent.push({ clientId, payload }), deps);

  const h: Harness = {
    tunnel,
    sent,
    deps,
    lastClientPub: null,
    append(sessionId, data) {
      stream.set(sessionId, (stream.get(sessionId) ?? '') + data);
    },
    markNow(sessionId) {
      return (stream.get(sessionId) ?? '').length;
    },
    openChannel(clientId, opts = {}) {
      const clientKeys = crypto.generateKeyPairSync('x25519');
      const pubB64 = Buffer.from(
        (clientKeys.publicKey.export({ format: 'jwk' }) as { x: string }).x,
        'base64url',
      ).toString('base64');
      h.lastClientPub = pubB64;
      const payload: Record<string, unknown> = { clientX25519Pub: pubB64 };
      if (opts.certificate !== undefined) payload.certificate = opts.certificate;
      tunnel.open(clientId, payload, opts.principal);

      const handshake = sent.find(
        (m) => m.clientId === clientId && (m.payload as { type?: string })?.type === 'handshake',
      );
      if (!handshake) return null;
      const hp = handshake.payload as { agentX25519Pub: string };
      const agentPub = crypto.createPublicKey({
        key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(hp.agentX25519Pub, 'base64').toString('base64url') },
        format: 'jwk',
      });
      const shared = crypto.diffieHellman({ privateKey: clientKeys.privateKey, publicKey: agentPub });
      return deriveSessionKey(shared);
    },
    send(clientId, key, n, obj) {
      tunnel.frame(clientId, sealJson(key, n, obj));
    },
    opened(clientId, key) {
      return sent
        .filter((m) => m.clientId === clientId && (m.payload as { ct?: string })?.ct)
        .map((m) => {
          try {
            return openJson(key, m.payload as never) as { type?: string };
          } catch {
            return { type: '__unreadable__' };
          }
        });
    },
  };
  return h;
}

/** Mint a certificate the way the desktop would. */
function mintCertificate(over: Record<string, unknown> = {}): string {
  const parts = {
    grantId: 'grant-1',
    machineId: MACHINE_ID,
    relayOrigin: RELAY_ORIGIN,
    granteeUserId: GUEST_ID,
    role: 'viewer',
    issuedAt: NOW - 1000,
    expiresAt: NOW + 3_600_000,
    ...over,
  };
  const payload = new TextEncoder().encode(
    [
      'grant:v1',
      parts.grantId,
      parts.machineId,
      parts.relayOrigin,
      parts.granteeUserId,
      parts.role,
      String(parts.issuedAt),
      String(parts.expiresAt),
    ].join('\n'),
  );
  const sig = crypto.sign(null, Buffer.from(payload), machineKeys.privateKey);
  return `grant:v1.${Buffer.from(payload).toString('base64url')}.${sig.toString('base64url')}`;
}

const storedGrant = (over: Partial<TunnelStoredGrant> = {}): TunnelStoredGrant => ({
  id: 'grant-1',
  granteeUserId: GUEST_ID,
  role: 'viewer',
  status: 'active',
  sessions: [{ sessionId: 's1', ptyEpoch: 111 }],
  ...over,
});

describe('who gets a channel at all', () => {
  test('the confirmed owner does', () => {
    const h = harness();
    expect(h.openChannel('c1', { principal: { userId: OWNER_ID } })).not.toBeNull();
  });

  test('a stranger with no certificate does not', () => {
    const h = harness();
    expect(h.openChannel('c1', { principal: { userId: 'nobody' } })).toBeNull();
    expect(h.sent[0]!.payload).toEqual({ type: 'denied', reason: 'not_authorized' });
  });

  test('a stranger presenting a certificate for an unknown grant does not', () => {
    // A valid signature is not enough — the certificate would be a bearer
    // token otherwise. Our own table is the authority on whether it exists.
    const h = harness({ grantRow: null });
    expect(h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })).toBeNull();
  });

  test('a revoked grant is refused even though the certificate still verifies', () => {
    const h = harness({ grantRow: storedGrant({ status: 'revoked' }) });
    expect(h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })).toBeNull();
  });

  test('a certificate replayed onto another principal is refused', () => {
    const h = harness({ grantRow: storedGrant() });
    expect(h.openChannel('c1', { principal: { userId: 'someone-else' }, certificate: mintCertificate() })).toBeNull();
  });

  test('a certificate minted against another relay is refused', () => {
    const h = harness({ grantRow: storedGrant() });
    const cert = mintCertificate({ relayOrigin: 'https://evil.example.com' });
    expect(h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: cert })).toBeNull();
  });

  test('a valid grant whose sessions have all been restarted is refused', () => {
    // pty_epoch binds a share to the PTY INSTANCE. sessions.id survives
    // stop/restart, so without this a share of one session would follow the
    // row into whatever it becomes weeks later.
    const h = harness({ grantRow: storedGrant({ sessions: [{ sessionId: 's1', ptyEpoch: 999 }] }) });
    expect(h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })).toBeNull();
  });

  test('a valid guest certificate does get a channel', () => {
    const h = harness({ grantRow: storedGrant() });
    expect(h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })).not.toBeNull();
  });

  test('a duplicate client:open is refused rather than re-keyed', () => {
    const h = harness();
    expect(h.openChannel('c1', { principal: { userId: OWNER_ID } })).not.toBeNull();
    const before = h.sent.length;
    h.tunnel.open('c1', { clientX25519Pub: 'AAAA' }, { userId: OWNER_ID });
    expect(h.sent.length).toBe(before);
  });
});

describe('the unconfirmed-owner fallback and its latch', () => {
  test('before the owner id is confirmed, a client is treated as the owner', () => {
    // Pre-sharing behaviour: the relay only routes a machine's own owner here
    // unless a grant exists, so this must not lock people out on upgrade.
    const h = harness({ grants: { get: () => null, ownerUserId: () => null, enforced: () => false, latch: () => {} } });
    const key = h.openChannel('c1', { principal: { userId: 'whoever' } });
    expect(key).not.toBeNull();
    h.send('c1', key!, 0, { type: 'dirs:list', path: '/' });
    expect(h.opened('c1', key!).some((m) => m.type === 'denied')).toBe(false);
  });

  test('once enforcement is latched, that fallback is gone for good', () => {
    const h = harness({
      grants: { get: () => null, ownerUserId: () => null, enforced: () => true, latch: () => {} },
    });
    expect(h.openChannel('c1', { principal: { userId: 'whoever' } })).toBeNull();
  });

  test('enforcing one certificate latches it', () => {
    // The latch closes the moment sharing is genuinely in use, which is what
    // makes the beta window safe — not a deletion date.
    let latched = false;
    const h = harness({
      grantRow: storedGrant(),
      grants: {
        get: () => storedGrant(),
        ownerUserId: () => null,
        enforced: () => latched,
        latch: () => {
          latched = true;
        },
      },
    });
    expect(h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })).not.toBeNull();
    expect(latched).toBe(true);
    // And now the fallback is closed for the next client.
    expect(h.openChannel('c2', { principal: { userId: 'whoever' } })).toBeNull();
  });
});

describe('the capability gate is consulted by dispatch', () => {
  test('a viewer is refused every command it lacks the capability for', () => {
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;

    const refused = ['terminal:input', 'terminal:resize', 'session:create', 'group:create', 'dirs:list'];
    refused.forEach((type, i) => h.send('c1', key, i, { type, sessionId: 's1', data: 'x', name: 'n', groupId: 'g1' }));

    const denials = h.opened('c1', key).filter((m) => m.type === 'command:denied');
    expect(denials.map((d) => d.command).sort()).toEqual([...refused].sort());
  });

  test('a viewer typing does not reach the PTY', () => {
    // The denial must be a refusal, not merely a missing reply.
    const writes: string[] = [];
    const h = harness({ grantRow: storedGrant() });
    h.deps.pty.write = (id, data) => writes.push(`${id}:${data}`);
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;

    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    h.send('c1', key, 1, { type: 'terminal:input', sessionId: 's1', data: 'rm -rf /\r' });

    expect(writes).toEqual([]);
  });

  test('the owner may run every command in the table', () => {
    const h = harness();
    const key = h.openChannel('c1', { principal: { userId: OWNER_ID } })!;
    Object.keys(COMMAND_CAPS).forEach((type, i) =>
      h.send('c1', key, i, { type, sessionId: 's1', data: 'x', name: 'n', groupId: 'g1', path: '/' }),
    );
    expect(h.opened('c1', key).filter((m) => m.type === 'command:denied')).toEqual([]);
  });

  test('an unknown command is ignored, not executed', () => {
    const h = harness();
    const key = h.openChannel('c1', { principal: { userId: OWNER_ID } })!;
    const before = h.sent.length;
    h.send('c1', key, 0, { type: 'shell:exec', data: 'whoami' });
    expect(h.sent.length).toBe(before);
  });

  test('scope is per session — a guest cannot reach one it was not given', () => {
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's2' });
    expect(h.opened('c1', key).some((m) => m.type === 'command:denied' && m.command === 'terminal:subscribe')).toBe(true);
  });
});

describe('scoped disclosure', () => {
  test('a guest sees only its own sessions, without working directories', () => {
    // A path is a disclosure about the machine — usernames, client names,
    // directory layout — and a guest has no use for one.
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    h.send('c1', key, 0, { type: 'sessions:list' });

    const msg = h.opened('c1', key).find((m) => m.type === 'sessions') as { sessions: Record<string, unknown>[] };
    expect(msg.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(msg.sessions[0]).not.toHaveProperty('workingDir');
    expect(JSON.stringify(msg)).not.toContain('secret-project');
  });

  test('a guest only learns about groups containing a session it can see', () => {
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    h.send('c1', key, 0, { type: 'groups:list' });

    const msg = h.opened('c1', key).find((m) => m.type === 'groups') as { groups: Record<string, unknown>[] };
    expect(msg.groups.map((g) => g.id)).toEqual(['g1']);
    expect(msg.groups[0]).not.toHaveProperty('workingDir');
  });

  test('the owner still gets everything, paths included', () => {
    const h = harness();
    const key = h.openChannel('c1', { principal: { userId: OWNER_ID } })!;
    h.send('c1', key, 0, { type: 'sessions:list' });

    const msg = h.opened('c1', key).find((m) => m.type === 'sessions') as { sessions: Record<string, unknown>[] };
    expect(msg.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(msg.sessions[0]!.workingDir).toBe('/home/will/secret-project');
  });

  test('a guest is not sent an unprompted session list on open', () => {
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    expect(h.opened('c1', key).some((m) => m.type === 'sessions')).toBe(false);
  });

  test('a guest gets no scrollback, only a marker', async () => {
    // Replaying history would hand over everything typed before the decision
    // to share was made.
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    await Bun.sleep(5);

    const output = h.opened('c1', key).filter((m) => m.type === 'terminal:output');
    expect(output).toHaveLength(1);
    expect(String(output[0]!.data)).toContain('shared from here');
    expect(JSON.stringify(output)).not.toContain('OWNER SCROLLBACK');
  });

  test('the owner does get scrollback', async () => {
    const h = harness();
    const key = h.openChannel('c1', { principal: { userId: OWNER_ID } })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    await Bun.sleep(5);

    const output = h.opened('c1', key).filter((m) => m.type === 'terminal:output');
    expect(output.map((o) => o.data).join('')).toContain('OWNER SCROLLBACK');
  });
});

/**
 * #169. Sending a guest nothing on every attach is not the same rule as "no
 * scrollback": it also throws away what they were already shown, so leaving a
 * shared session to look at your own and coming back wiped it. The window
 * since the share began is theirs; everything before it still is not.
 */
describe('a guest coming back to a session they already watched', () => {
  const guest = (h: ReturnType<typeof harness>, clientId: string) =>
    h.openChannel(clientId, { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;

  test('is replayed what it has already seen, and nothing from before the share', async () => {
    const h = harness({ grantRow: storedGrant() });
    // What the approval flow records at the moment of consent.
    h.tunnel.noteShareMarks('grant-1', [{ sessionId: 's1', mark: h.markNow('s1') }], NOW + HOUR);
    h.append('s1', 'AFTER ONE');

    const key = guest(h, 'c1');
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    await Bun.sleep(5);

    // They step away to one of their own sessions; output keeps arriving.
    h.send('c1', key, 1, { type: 'terminal:unsubscribe', sessionId: 's1' });
    h.append('s1', ' AND TWO');

    h.send('c1', key, 2, { type: 'terminal:subscribe', sessionId: 's1' });
    await Bun.sleep(5);

    const replayed = h
      .opened('c1', key)
      .filter((m) => m.type === 'terminal:output')
      .map((m) => String(m.data))
      .join('');
    expect(replayed).toContain('AFTER ONE AND TWO');
    expect(replayed).not.toContain('BEFORE THE SHARE');
  });

  test('with no recorded mark, starts its window at the first attach', async () => {
    // A grant minted without a mark must not fall back to position zero —
    // that would replay the entire scrollback to someone entitled to none.
    const h = harness({ grantRow: storedGrant() });

    const key = guest(h, 'c1');
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    await Bun.sleep(5);
    h.send('c1', key, 1, { type: 'terminal:unsubscribe', sessionId: 's1' });
    h.append('s1', 'ONLY THIS');
    h.send('c1', key, 2, { type: 'terminal:subscribe', sessionId: 's1' });
    await Bun.sleep(5);

    const replayed = h
      .opened('c1', key)
      .filter((m) => m.type === 'terminal:output')
      .map((m) => String(m.data))
      .join('');
    expect(replayed).toContain('ONLY THIS');
    expect(replayed).not.toContain('BEFORE THE SHARE');
  });

  test('every attach still says where the share starts', async () => {
    const h = harness({ grantRow: storedGrant() });
    h.tunnel.noteShareMarks('grant-1', [{ sessionId: 's1', mark: h.markNow('s1') }], NOW + HOUR);

    const key = guest(h, 'c1');
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    await Bun.sleep(5);

    const first = h.opened('c1', key).filter((m) => m.type === 'terminal:output');
    expect(String(first[0]!.data)).toContain('shared from here');
  });

  test('a second approval does not move an already-recorded window forward', async () => {
    // Approval is one-shot per grantId today — `pendingGrants` is cleared and
    // `insertGrant` would collide — but if it ever stops being, recomputing
    // the marks would hide everything produced between the two calls from a
    // guest already watching. First write wins.
    const h = harness({ grantRow: storedGrant() });
    h.tunnel.noteShareMarks('grant-1', [{ sessionId: 's1', mark: h.markNow('s1') }], NOW + HOUR);
    h.append('s1', 'BETWEEN THE TWO APPROVALS');
    h.tunnel.noteShareMarks('grant-1', [{ sessionId: 's1', mark: h.markNow('s1') }], NOW + HOUR);

    const key = guest(h, 'c1');
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    await Bun.sleep(5);

    const replayed = h
      .opened('c1', key)
      .filter((m) => m.type === 'terminal:output')
      .map((m) => String(m.data))
      .join('');
    expect(replayed).toContain('BETWEEN THE TWO APPROVALS');
  });

  test('a window whose grant ran out is swept, not held for the life of the process', async () => {
    // Revocation reaches the map through revokeGrant, but expiry does not: a
    // grant approved, never connected to, and simply timed out leaves no
    // client behind to carry its window out. So the map is swept on write and
    // on open. Observed through behaviour — a swept window falls back to
    // starting at the next attach — since the map itself is private.
    const clock = { now: NOW };
    const h = harness({ grantRow: storedGrant(), now: () => clock.now });
    h.tunnel.noteShareMarks('grant-1', [{ sessionId: 's1', mark: h.markNow('s1') }], NOW + 1000);
    h.append('s1', 'PRODUCED WHILE NOBODY WATCHED');

    clock.now = NOW + 2000; // the grant's clock runs out with nobody attached

    // A later channel sweeps it. In production the certificate would have
    // expired with it; here it carries a fresh expiry so the sweep — not the
    // certificate check — is what the assertion is about.
    const key = h.openChannel('c1', {
      principal: { userId: GUEST_ID },
      certificate: mintCertificate({ expiresAt: NOW + HOUR }),
    })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    await Bun.sleep(5);

    const replayed = h
      .opened('c1', key)
      .filter((m) => m.type === 'terminal:output')
      .map((m) => String(m.data))
      .join('');
    expect(replayed).not.toContain('PRODUCED WHILE NOBODY WATCHED');
  });

  test('revoking the grant forgets the window it opened', async () => {
    // Otherwise a re-approval would inherit a start point from access that was
    // taken away, and replay output produced while the guest had none.
    const h = harness({ grantRow: storedGrant() });
    h.tunnel.noteShareMarks('grant-1', [{ sessionId: 's1', mark: h.markNow('s1') }], NOW + HOUR);
    h.append('s1', 'WHILE REVOKED');
    h.tunnel.revokeGrant('grant-1');

    const key = guest(h, 'c2');
    h.send('c2', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    await Bun.sleep(5);

    const replayed = h
      .opened('c2', key)
      .filter((m) => m.type === 'terminal:output')
      .map((m) => String(m.data))
      .join('');
    expect(replayed).not.toContain('WHILE REVOKED');
  });
});

describe('revocation of a live client', () => {
  test('drops it to DENY_ALL and tells it, sealed', () => {
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });

    h.tunnel.revokeClient('c1');

    // The notice is sealed: an unsealed "your access ended" is forgeable by
    // the relay, which turns a revocation into a clean phishing lever.
    const opened = h.opened('c1', key);
    expect(opened.some((m) => m.type === 'denied' && m.reason === 'revoked')).toBe(true);
    expect(opened.some((m) => m.type === '__unreadable__')).toBe(false);

    // And nothing works afterwards.
    h.send('c1', key, 1, { type: 'sessions:list' });
    const after = h.opened('c1', key).filter((m) => m.type === 'sessions');
    expect(after).toHaveLength(0);
  });
});

describe('PTY listener lifecycle', () => {
  let attached = 0;

  beforeEach(() => {
    attached = 0;
  });

  test('one listener set for the whole tunnel, released when the last client goes', () => {
    const h = harness({
      pty: {
        subscribe: () => {
          attached += 1;
          return () => {
            attached -= 1;
          };
        },
        write: () => {},
        resize: () => {},
        getSize: () => ({ cols: 80, rows: 24 }),
        isLive: () => true,
        ptyEpoch: () => 111,
        getSerializedBuffer: async () => '',
        scrollbackMark: () => 0,
        getSerializedBufferSince: async () => '',
      },
    });

    h.openChannel('c1', { principal: { userId: OWNER_ID } });
    h.openChannel('c2', { principal: { userId: OWNER_ID } });
    expect(attached).toBe(1);

    h.tunnel.closeClient('c1');
    expect(attached).toBe(1);
    h.tunnel.closeClient('c2');
    expect(attached).toBe(0);
  });

  test('a refused client never attaches listeners', () => {
    const h = harness({
      grants: { get: () => null, ownerUserId: () => OWNER_ID, enforced: () => false, latch: () => {} },
      pty: {
        subscribe: () => {
          attached += 1;
          return () => {
            attached -= 1;
          };
        },
        write: () => {},
        resize: () => {},
        getSize: () => ({ cols: 80, rows: 24 }),
        isLive: () => true,
        ptyEpoch: () => 111,
        getSerializedBuffer: async () => '',
        scrollbackMark: () => 0,
        getSerializedBufferSince: async () => '',
      },
    });

    h.openChannel('c1', { principal: { userId: 'nobody' } });
    expect(attached).toBe(0);
  });
});

describe('the handshake proof still binds the ephemeral key to this machine', () => {
  test('the signature verifies over both public keys', () => {
    // Authorization changed in this milestone; the M5.0 replay fix must not
    // have been disturbed by it.
    const h = harness();
    h.openChannel('c1', { principal: { userId: OWNER_ID } });
    const hs = h.sent.find((m) => (m.payload as { type?: string })?.type === 'handshake')!.payload as {
      agentX25519Pub: string;
      ed25519Pub: string;
      signature: string;
    };

    expect(hs.ed25519Pub).toBe(MACHINE_PUB_B64);
    const proof = buildHandshakeProof(h.lastClientPub!, hs.agentX25519Pub);
    expect(
      crypto.verify(null, Buffer.from(proof), machineKeys.publicKey, Buffer.from(hs.signature, 'base64')),
    ).toBe(true);
  });

  test('the agent key is fresh per channel, so a recorded channel cannot be replayed', () => {
    const h = harness();
    h.openChannel('c1', { principal: { userId: OWNER_ID } });
    h.openChannel('c2', { principal: { userId: OWNER_ID } });
    const agentKeys = h.sent
      .filter((m) => (m.payload as { type?: string })?.type === 'handshake')
      .map((m) => (m.payload as { agentX25519Pub: string }).agentX25519Pub);
    expect(agentKeys).toHaveLength(2);
    expect(agentKeys[0]).not.toBe(agentKeys[1]);
  });
});

describe('presence', () => {
  test('a guest appears only once they are actually watching something', () => {
    // "dana-k is here" and "dana-k is looking at this terminal right now" are
    // different claims. Only the second is useful to an owner deciding
    // whether to keep typing.
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', {
      principal: { userId: GUEST_ID, githubLogin: 'dana-k', displayName: 'Dana' },
      certificate: mintCertificate(),
    })!;

    expect(h.tunnel.attachedGuests()).toHaveLength(1);
    expect(h.tunnel.attachedGuests()[0]!.sessionIds).toEqual([]);

    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    expect(h.tunnel.attachedGuests()[0]!.sessionIds).toEqual(['s1']);
  });

  test('presence carries the handle, which is what the owner is shown', () => {
    const h = harness({ grantRow: storedGrant() });
    h.openChannel('c1', {
      principal: { userId: GUEST_ID, githubLogin: 'dana-k', displayName: 'Dana' },
      certificate: mintCertificate(),
    });
    expect(h.tunnel.attachedGuests()[0]).toMatchObject({ login: 'dana-k', displayName: 'Dana', role: 'viewer' });
  });

  test('the owner is never listed as a guest', () => {
    // Otherwise every owner would appear to be watching themselves.
    const h = harness();
    h.openChannel('c1', { principal: { userId: OWNER_ID } });
    expect(h.tunnel.attachedGuests()).toEqual([]);
  });

  test('unsubscribing removes the session from presence', () => {
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    h.send('c1', key, 1, { type: 'terminal:unsubscribe', sessionId: 's1' });
    expect(h.tunnel.attachedGuests()[0]!.sessionIds).toEqual([]);
  });

  test('disconnecting removes the guest entirely', () => {
    // Detach is as load-bearing as attach: an owner who never sees someone
    // leave cannot tell watching from watched-once.
    const h = harness({ grantRow: storedGrant() });
    h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() });
    h.tunnel.closeClient('c1');
    expect(h.tunnel.attachedGuests()).toEqual([]);
  });

  test('every presence transition notifies the owner surfaces', () => {
    // Attach, subscribe, unsubscribe and detach must each push, or the badge
    // goes stale and quietly lies about who is watching.
    let notifications = 0;
    const h = harness({ grantRow: storedGrant(), onPresenceChange: () => { notifications += 1; } });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    const afterAttach = notifications;
    expect(afterAttach).toBeGreaterThan(0);

    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    expect(notifications).toBeGreaterThan(afterAttach);
    const afterSub = notifications;

    h.send('c1', key, 1, { type: 'terminal:unsubscribe', sessionId: 's1' });
    expect(notifications).toBeGreaterThan(afterSub);
    const afterUnsub = notifications;

    h.tunnel.closeClient('c1');
    expect(notifications).toBeGreaterThan(afterUnsub);
  });

  test('an owner attaching does not notify the presence surfaces', () => {
    let notifications = 0;
    const h = harness({ onPresenceChange: () => { notifications += 1; } });
    h.openChannel('c1', { principal: { userId: OWNER_ID } });
    expect(notifications).toBe(0);
  });
});

describe('revokeGrant', () => {
  test('cuts every client holding that grant, not just one', () => {
    // One person may have several browsers open under one grant. Missing one
    // would leave a guest still watching a terminal the owner believes they
    // have been removed from.
    const h = harness({ grantRow: storedGrant() });
    const k1 = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    const k2 = h.openChannel('c2', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    h.send('c1', k1, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    h.send('c2', k2, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    expect(h.tunnel.attachedGuests()).toHaveLength(2);

    h.tunnel.revokeGrant('grant-1');

    expect(h.tunnel.attachedGuests().every((g) => g.sessionIds.length === 0)).toBe(true);
    for (const [id, key] of [['c1', k1], ['c2', k2]] as const) {
      const opened = h.opened(id, key);
      expect(opened.some((m) => m.type === 'denied' && m.reason === 'revoked')).toBe(true);
    }
  });

  test('leaves clients holding a different grant alone', () => {
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });

    h.tunnel.revokeGrant('some-other-grant');

    expect(h.tunnel.attachedGuests()[0]!.sessionIds).toEqual(['s1']);
    expect(h.opened('c1', key).some((m) => m.type === 'denied')).toBe(false);
  });

  test('the owner is unaffected by a grant revocation', () => {
    const h = harness();
    const key = h.openChannel('c1', { principal: { userId: OWNER_ID } })!;
    h.tunnel.revokeGrant('grant-1');
    h.send('c1', key, 0, { type: 'sessions:list' });
    expect(h.opened('c1', key).some((m) => m.type === 'sessions')).toBe(true);
  });
});

describe('a lapsed grant stops the stream, not just the commands', () => {
  /** Drive the PTY data listener the tunnel registered. */
  function harnessWithPty() {
    let emit: ((e: { id: string; data: string }) => void) | null = null;
    const h = harness({
      grantRow: storedGrant(),
      pty: {
        subscribe: (handlers) => {
          emit = handlers.data;
          return () => { emit = null; };
        },
        write: () => {},
        resize: () => {},
        getSize: () => ({ cols: 80, rows: 24 }),
        isLive: () => true,
        ptyEpoch: () => 111,
        getSerializedBuffer: async () => '',
        scrollbackMark: () => 0,
        getSerializedBufferSince: async () => '',
      },
    });
    return { h, emit: (data: string) => emit?.({ id: 's1', data }) };
  }

  test('output stops once the grant has expired', () => {
    // permits() gates INBOUND commands. Without a check at fan-out, an expired
    // guest keeps RECEIVING live terminal output for as long as their socket
    // stays open — and the stream is the thing being protected.
    let now = NOW;
    const { h, emit } = harnessWithPty();
    h.deps.now = () => now;

    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });

    emit('BEFORE');
    expect(h.opened('c1', key).some((m) => m.data === 'BEFORE')).toBe(true);

    now = NOW + 4_000_000; // past the certificate's expiry
    emit('AFTER');

    const seen = h.opened('c1', key);
    expect(seen.some((m) => m.data === 'AFTER')).toBe(false);
    // And they are told, rather than left watching a frozen screen.
    expect(seen.some((m) => m.type === 'denied' && m.reason === 'expired')).toBe(true);
  });

  test('a revoked guest stops receiving output immediately', () => {
    const { h, emit } = harnessWithPty();
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });

    h.tunnel.revokeGrant('grant-1');
    emit('AFTER REVOKE');

    const seen = h.opened('c1', key);
    expect(seen.some((m) => m.data === 'AFTER REVOKE')).toBe(false);
    // The REASON matters, not just the silence: DENY_ALL carries expiresAt 0,
    // so a naive timestamp check would tell a revoked guest their access
    // "expired" — a different and misleading story.
    expect(seen.some((m) => m.type === 'denied' && m.reason === 'revoked')).toBe(true);
    expect(seen.some((m) => m.type === 'denied' && m.reason === 'expired')).toBe(false);
  });

  test('the owner keeps receiving output regardless of grant clocks', () => {
    // ownerGrant() never expires; a bug that expired owners would take the
    // machine away from its own user.
    let now = NOW;
    const { h, emit } = harnessWithPty();
    h.deps.now = () => now;

    const key = h.openChannel('c1', { principal: { userId: OWNER_ID } })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });

    now = NOW + 10_000_000_000;
    emit('STILL MINE');
    expect(h.opened('c1', key).some((m) => m.data === 'STILL MINE')).toBe(true);
  });

  test('an expired guest disappears from presence', () => {
    let now = NOW;
    const { h, emit } = harnessWithPty();
    h.deps.now = () => now;

    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    expect(h.tunnel.attachedGuests()[0]!.sessionIds).toEqual(['s1']);

    now = NOW + 4_000_000;
    emit('tick');
    expect(h.tunnel.attachedGuests()[0]!.sessionIds).toEqual([]);
  });
});

describe('a refused command is not an ended session', () => {
  // Found in production on beta.4: a guest sent one command their role does
  // not allow, the tunnel replied `denied`, and the web client — which read
  // every `denied` as terminal — told them the owner had revoked their access.
  // One frame type was carrying two meanings.
  test('refusing a command uses a distinct type from access-ended', () => {
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;

    h.send('c1', key, 0, { type: 'terminal:input', sessionId: 's1', data: 'x' });

    const seen = h.opened('c1', key);
    expect(seen.some((m) => m.type === 'command:denied' && m.command === 'terminal:input')).toBe(true);
    // The frame that means "you are out" must NOT be what a refusal produces.
    expect(seen.some((m) => m.type === 'denied')).toBe(false);
  });

  test('the client keeps working after a refusal', () => {
    // The guest stays connected and their grant is untouched — the refusal is
    // about one command, not about them.
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;

    h.send('c1', key, 0, { type: 'terminal:resize', sessionId: 's1', cols: 80, rows: 24 });
    h.send('c1', key, 1, { type: 'sessions:list' });

    expect(h.opened('c1', key).some((m) => m.type === 'sessions')).toBe(true);
  });

  test('losing access still uses the ended frame', () => {
    // The two paths must stay distinguishable in the other direction too.
    const h = harness({ grantRow: storedGrant() });
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;

    h.tunnel.revokeGrant('grant-1');

    const seen = h.opened('c1', key);
    expect(seen.some((m) => m.type === 'denied' && m.reason === 'revoked')).toBe(true);
    expect(seen.some((m) => m.type === 'command:denied')).toBe(false);
  });
});

describe('a guest asking to be fitted to their screen', () => {
  /** A harness whose clock the test can move, plus the requests it forwarded. */
  function askHarness() {
    const requests: GuestResizeRequest[] = [];
    const resizes: string[] = [];
    let now = NOW;
    const h = harness({
      grantRow: storedGrant(),
      now: () => now,
      onResizeRequest: (request) => requests.push(request),
    });
    h.deps.pty.resize = (id, cols, rows) => resizes.push(`${id}:${cols}x${rows}`);
    const key = h.openChannel('c1', { principal: { userId: GUEST_ID, githubLogin: 'dana-k' }, certificate: mintCertificate() })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    return { h, key, requests, resizes, advance: (ms: number) => { now += ms; } };
  }

  test('a viewer may ask — and the ask resizes nothing', () => {
    // The whole point of a request message: a phone must never reflow the
    // owner's terminal, so this reaches the owner's UI and stops there.
    const { h, key, requests, resizes } = askHarness();

    h.send('c1', key, 1, { type: 'terminal:resize-request', sessionId: 's1', cols: 80, rows: 24 });

    expect(requests).toEqual([
      { sessionId: 's1', cols: 80, rows: 24, login: 'dana-k', displayName: null },
    ]);
    expect(resizes).toEqual([]);
    expect(h.opened('c1', key).some((m) => m.type === 'command:denied')).toBe(false);
  });

  test('a client with no grant cannot ask at all', () => {
    // DENY_ALL holds no capabilities, so the gate refuses this like anything
    // else — asking is not a back door around having been let in.
    const { h, key, requests } = askHarness();
    h.tunnel.revokeClient('c1');

    h.send('c1', key, 1, { type: 'terminal:resize-request', sessionId: 's1', cols: 80, rows: 24 });

    expect(requests).toEqual([]);
    expect(h.opened('c1', key).some((m) => m.type === 'command:denied' && m.command === 'terminal:resize-request')).toBe(true);
  });

  test('a session outside the grant is refused before the owner is disturbed', () => {
    const { h, key, requests } = askHarness();

    h.send('c1', key, 1, { type: 'terminal:resize-request', sessionId: 's2', cols: 80, rows: 24 });

    expect(requests).toEqual([]);
    expect(h.opened('c1', key).some((m) => m.type === 'command:denied' && m.command === 'terminal:resize-request')).toBe(true);
  });

  test('a session in scope but not being watched raises nothing', () => {
    // Same rule as terminal:input: the ask is about the session in front of
    // them, and a request for one they are not attached to is malformed.
    const { h, key, requests } = askHarness();
    h.send('c1', key, 1, { type: 'terminal:unsubscribe', sessionId: 's1' });

    h.send('c1', key, 2, { type: 'terminal:resize-request', sessionId: 's1', cols: 80, rows: 24 });

    expect(requests).toEqual([]);
  });

  test('a made-up size is clamped before it reaches the prompt', () => {
    // The number lands in copy the owner reads and in a native resize if they
    // accept, so it is sanitised on the way in like any other remote size.
    const { h, key, requests } = askHarness();

    h.send('c1', key, 1, { type: 'terminal:resize-request', sessionId: 's1', cols: 999_999, rows: 0.5 });

    expect(requests).toEqual([
      { sessionId: 's1', cols: 1000, rows: 2, login: 'dana-k', displayName: null },
    ]);
  });

  test('a non-numeric size is dropped rather than clamped into something', () => {
    const { h, key, requests } = askHarness();

    h.send('c1', key, 1, { type: 'terminal:resize-request', sessionId: 's1', cols: 'wide', rows: null });

    expect(requests).toEqual([]);
  });

  test('a flood of asks raises one prompt, not one per frame', () => {
    // Each request interrupts the owner. A prompt a guest can raise at will
    // is a way to make the desktop unusable.
    const { h, key, requests } = askHarness();

    for (let i = 0; i < 20; i++) {
      h.send('c1', key, i + 1, { type: 'terminal:resize-request', sessionId: 's1', cols: 80 + i, rows: 24 });
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]!.cols).toBe(80);
  });

  test('six sockets under one certificate are still one asker', () => {
    // The relay mints a fresh clientId per socket and nothing caps how many a
    // guest may open, so a throttle kept on the socket is a browser refresh
    // away from free — six channels, six prompts, same instant.
    const requests: GuestResizeRequest[] = [];
    const h = harness({ grantRow: storedGrant(), onResizeRequest: (r) => requests.push(r) });

    for (let i = 0; i < 6; i++) {
      const id = `c${i}`;
      const key = h.openChannel(id, { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
      h.send(id, key, 0, { type: 'terminal:subscribe', sessionId: 's1' });
      h.send(id, key, 1, { type: 'terminal:resize-request', sessionId: 's1', cols: 80 + i, rows: 24 });
    }

    expect(requests).toHaveLength(1);
  });

  test('two different people are not throttled against each other', () => {
    // The key is the grant, not a global bucket: one guest asking must not
    // silence another guest's first ask.
    const requests: GuestResizeRequest[] = [];
    const other = storedGrant({ id: 'grant-2', granteeUserId: 'guest-two' });
    const h = harness({
      onResizeRequest: (r) => requests.push(r),
      grants: {
        get: (id) => (id === 'grant-2' ? other : storedGrant()),
        ownerUserId: () => OWNER_ID,
        enforced: () => true,
        latch: () => {},
      },
    });

    const one = h.openChannel('c1', { principal: { userId: GUEST_ID }, certificate: mintCertificate() })!;
    h.send('c1', one, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    h.send('c1', one, 1, { type: 'terminal:resize-request', sessionId: 's1', cols: 80, rows: 24 });

    const two = h.openChannel('c2', {
      principal: { userId: 'guest-two' },
      certificate: mintCertificate({ grantId: 'grant-2', granteeUserId: 'guest-two' }),
    })!;
    h.send('c2', two, 0, { type: 'terminal:subscribe', sessionId: 's1' });
    h.send('c2', two, 1, { type: 'terminal:resize-request', sessionId: 's1', cols: 90, rows: 30 });

    expect(requests.map((r) => r.cols)).toEqual([80, 90]);
  });

  test('after the interval they may ask again — a decline is not a ban', () => {
    const { h, key, requests, advance } = askHarness();
    h.send('c1', key, 1, { type: 'terminal:resize-request', sessionId: 's1', cols: 80, rows: 24 });

    advance(11_000);
    h.send('c1', key, 2, { type: 'terminal:resize-request', sessionId: 's1', cols: 90, rows: 30 });

    expect(requests.map((r) => r.cols)).toEqual([80, 90]);
  });

  test('the owner learns who asked, by the identity they cannot change', () => {
    const requests: GuestResizeRequest[] = [];
    const h = harness({ grantRow: storedGrant(), onResizeRequest: (r) => requests.push(r) });
    const key = h.openChannel('c1', {
      principal: { userId: GUEST_ID, githubLogin: null, displayName: 'Dana K' },
      certificate: mintCertificate(),
    })!;
    h.send('c1', key, 0, { type: 'terminal:subscribe', sessionId: 's1' });

    h.send('c1', key, 1, { type: 'terminal:resize-request', sessionId: 's1', cols: 80, rows: 24 });

    expect(requests[0]).toMatchObject({ login: null, displayName: 'Dana K' });
  });
});
