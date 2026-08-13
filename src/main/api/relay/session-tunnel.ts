/**
 * Per-web-client E2E terminal tunnel (agent side).
 *
 * The relay hands us opaque frames from a web client; we complete an X25519
 * handshake (signed with our Ed25519 identity so the client can prove it's
 * really talking to this machine), then exchange AES-256-GCM-sealed terminal
 * frames. The relay only ever sees ciphertext.
 *
 * **Authorization lives here, not at the relay.** Completing the handshake
 * proves you are talking to this machine; it does not say what you may do.
 * Every client starts at `DENY_ALL` and is widened only by a certificate this
 * machine signed, or by being the confirmed owner. `dispatch()` consults the
 * capability table in exactly one place so the gate cannot be bypassed by
 * adding a command.
 *
 * Every dependency is injected and this module imports nothing from Electron —
 * not `ptyManager`, not the repositories, not even `electron-log`. The deny
 * branches are the ones that matter, and `mock.module()` is process-wide in
 * bun, so mocking any of those here would break `pty-manager.test.ts` in a
 * load-order-dependent way. Production wiring lives in
 * `session-tunnel-deps.ts`. See `docs/designs/session-sharing.md` §6.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveEphemeral,
  deriveSessionKey,
  sealJson,
  openJson,
  buildHandshakeProof,
  type SealedFrame,
} from './e2e';
import { chunkText } from './chunking';
import { sanitizeSize } from './terminal-size';
import {
  checkCertificate,
  DENY_ALL,
  grantFrom,
  isSessionScoped,
  ownerGrant,
  parseCertificate,
  permits,
  type Grant,
} from './grants';

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface PtyDataEvent { id: string; data: string }
export interface PtyExitEvent { id: string; exitCode: number }
export interface PtyResizeEvent { id: string; cols: number; rows: number }

/** The slice of the PTY manager this tunnel uses. */
export interface TunnelPty {
  /** Attach all three listeners; the returned function detaches them. */
  subscribe(handlers: {
    data: (e: PtyDataEvent) => void;
    exit: (e: PtyExitEvent) => void;
    resize: (e: PtyResizeEvent) => void;
  }): () => void;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  getSize(id: string): { cols: number; rows: number };
  /** Whether a PTY is currently running for this session. */
  isLive(id: string): boolean;
  /** Identifies the PTY *instance*; changes when a session is restarted. */
  ptyEpoch(id: string): number | null;
  getSerializedBuffer(id: string): Promise<string>;
}

export interface TunnelSessionRow {
  id: string;
  name: string;
  state: string;
  groupId: string;
  workingDir: string;
  provider?: string;
  shellType?: string;
}

export interface TunnelGroupRow {
  id: string;
  name: string;
  color: string;
  workingDir: string;
  parentId: string | null;
}

/** The scope a grant covers, as this machine recorded it. */
export interface TunnelStoredGrant {
  id: string;
  granteeUserId: string;
  role: 'viewer' | 'operator';
  status: 'pending' | 'active' | 'revoked';
  sessions: { sessionId: string; ptyEpoch: number }[];
}

/**
 * Everything this tunnel needs from the outside world.
 *
 * Every Electron-touching dependency is a port, so this module imports only
 * `node:*` and its own pure siblings. That is what lets the deny-path tests
 * run without `mock.module()`, which is process-wide in bun and would break
 * `pty-manager.test.ts` in a load-order-dependent way. Production wiring lives
 * in `session-tunnel-deps.ts`.
 */
export interface TunnelDeps {
  pty: TunnelPty;
  sessions: { getAll(): TunnelSessionRow[] };
  groups: { getAll(): TunnelGroupRow[] };
  grants: {
    get(grantId: string): TunnelStoredGrant | null;
    ownerUserId(): string | null;
    enforced(): boolean;
    latch(): void;
  };
  /** Creating sessions and groups on behalf of an owner. */
  remote: {
    createSession(spec: { groupId: string; name: string; provider: string; launchClaude: boolean }): void;
    createGroup(spec: { name: string; parentId: string | null; workingDir: string; color: string }): void;
  };
  /** The machine identity, for the handshake proof and certificate checks. */
  identity: {
    ed25519Pub(): string;
    sign(message: Uint8Array): Buffer;
  };
  log: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
  /** The relay origin this agent is connected to, for certificate binding. */
  relayOrigin(): string;
  /** This machine's id as the relay knows it, or null before linking. */
  machineId(): string | null;
  now(): number;
}

/** The relay-asserted identity of a connecting socket. Never authorization. */
export interface Principal {
  userId: string;
}

interface ClientSession {
  key: Buffer;
  sendCounter: number;
  recvCounter: number;
  /** Session ids this client is streaming. */
  subs: Set<string>;
  /** What this client may do. Starts at DENY_ALL and is never widened later. */
  grant: Grant;
}

/** Decrypted command from a web client (union of every message's fields). */
interface ClientFrame {
  type?: string;
  sessionId?: string;
  data?: string;
  cols?: number;
  rows?: number;
  groupId?: string;
  name?: string;
  provider?: string;
  path?: string;
  parentId?: string | null;
  workingDir?: string;
  color?: string;
}

type Handler = (clientId: string, s: ClientSession, inner: ClientFrame) => void;

export class SessionTunnel {
  private readonly sessions = new Map<string, ClientSession>();
  /** Detaches the shared PTY listeners; null when not attached. */
  private detach: (() => void) | null = null;
  private readonly deps: TunnelDeps;

  /**
   * The command table. `dispatch()` looks a command up here and checks
   * `permits()` once, so a command added without a policy entry is refused
   * rather than inheriting whatever the previous case did.
   */
  private readonly commands: Readonly<Record<string, Handler>> = Object.freeze({
    'sessions:list': (clientId, s) => this.sendSessions(clientId, s),
    'groups:list': (clientId, s) => this.sendGroups(clientId, s),
    'terminal:subscribe': (clientId, s, inner) => void this.handleSubscribe(clientId, s, inner),
    'terminal:unsubscribe': (_clientId, s, inner) => {
      if (typeof inner.sessionId === 'string') s.subs.delete(inner.sessionId);
    },
    'terminal:input': (_clientId, s, inner) => {
      if (typeof inner.sessionId === 'string' && typeof inner.data === 'string' && s.subs.has(inner.sessionId)) {
        this.deps.pty.write(inner.sessionId, inner.data);
      }
    },
    'terminal:resize': (_clientId, s, inner) => {
      // The active viewer drives the shared PTY size so a phone can reflow to
      // fit. Network-triggered input into a native resize, so clamp it and
      // scope it to a session this client is actually subscribed to.
      const size = sanitizeSize(inner.cols, inner.rows);
      if (typeof inner.sessionId === 'string' && size && s.subs.has(inner.sessionId)) {
        this.deps.pty.resize(inner.sessionId, size.cols, size.rows);
      }
    },
    'session:create': (clientId, s, inner) => this.handleSessionCreate(clientId, s, inner),
    'group:create': (clientId, s, inner) => this.handleGroupCreate(clientId, s, inner),
    'dirs:list': (clientId, s, inner) => this.handleDirsList(clientId, s, inner),
  });

  /**
   * `route` sends an outbound payload to a client id via the relay.
   * `deps` defaults to the singletons; tests inject fakes.
   */
  constructor(
    private readonly route: (clientId: string, payload: unknown) => void,
    deps: TunnelDeps,
  ) {
    this.deps = deps;
  }

  // One listener per PTY event for the whole tunnel, fanned out to subscribed
  // clients. Previously each client attached its own three, which leaked a set
  // per duplicate `client:open` and tripped EventEmitter's default max of 10.
  private readonly onPtyData = (e: PtyDataEvent): void => {
    this.fanOut(e.id, (clientId) => this.sealTo(clientId, { type: 'terminal:output', sessionId: e.id, data: e.data }));
  };

  private readonly onPtyExit = (e: PtyExitEvent): void => {
    this.fanOut(e.id, (clientId) =>
      this.sealTo(clientId, { type: 'terminal:exit', sessionId: e.id, exitCode: e.exitCode }),
    );
  };

  private readonly onPtyResize = (e: PtyResizeEvent): void => {
    this.fanOut(e.id, (clientId) =>
      this.sealTo(clientId, { type: 'terminal:size', sessionId: e.id, cols: e.cols, rows: e.rows }),
    );
  };

  /** Run `send` for every client subscribed to `sessionId`. */
  private fanOut(sessionId: string, send: (clientId: string) => void): void {
    for (const [clientId, s] of this.sessions) {
      if (s.subs.has(sessionId)) send(clientId);
    }
  }

  private startListening(): void {
    if (this.detach) return;
    this.detach = this.deps.pty.subscribe({
      data: this.onPtyData,
      exit: this.onPtyExit,
      resize: this.onPtyResize,
    });
  }

  private stopListeningIfIdle(): void {
    if (!this.detach || this.sessions.size > 0) return;
    this.detach();
    this.detach = null;
  }

  /**
   * A web client opened a channel — authorize it, then complete the handshake.
   *
   * Ordering is deliberate and fail-closed: the grant is resolved *before* any
   * key material is derived and before any PTY listener is attached, so a
   * refused client never reaches a state that has to be unwound.
   */
  open(clientId: string, payload: unknown, principal?: Principal): void {
    try {
      const clientX25519Pub = (payload as { clientX25519Pub?: unknown })?.clientX25519Pub;
      if (typeof clientX25519Pub !== 'string') return;

      // The relay mints a fresh client id per socket, so a repeat means a
      // client sent `client:open` twice. Refuse rather than replace: replacing
      // would orphan the first channel's state and hand a second key to the
      // same id.
      if (this.sessions.has(clientId)) {
        this.deps.log.warn('[Relay] ignoring duplicate client:open', { clientId });
        return;
      }

      const grant = this.resolveGrant(payload, principal);
      if (grant === null) {
        this.deps.log.warn('[Relay] refusing a channel with no usable grant', { clientId });
        // Unsealed: no key exists yet, and there is nothing secret in it.
        this.route(clientId, { type: 'denied', reason: 'not_authorized' });
        return;
      }

      // A per-channel ephemeral keypair (see e2e.ts) — never the machine's
      // long-lived X25519 key, which would make this exchange replayable.
      const { sharedSecret, ephemeralPubB64 } = deriveEphemeral(
        new Uint8Array(Buffer.from(clientX25519Pub, 'base64')),
      );
      const key = deriveSessionKey(sharedSecret);
      const signature = this.deps.identity.sign(buildHandshakeProof(clientX25519Pub, ephemeralPubB64)).toString('base64');

      const session: ClientSession = { key, sendCounter: 0, recvCounter: -1, subs: new Set(), grant };
      this.sessions.set(clientId, session);
      this.startListening();

      // Unsealed handshake reply: the client verifies `signature` against the
      // machine's known Ed25519 pubkey — which is what binds this throwaway
      // X25519 key to this machine — then derives the same session key.
      this.route(clientId, {
        type: 'handshake',
        agentX25519Pub: ephemeralPubB64,
        ed25519Pub: this.deps.identity.ed25519Pub(),
        signature,
      });
      // Only the owner gets an unprompted session list; a guest asks, and gets
      // its own scope back.
      if (grant.role === 'owner') this.sendSessions(clientId, session);
      this.deps.log.info('[Relay] client channel opened', { clientId, role: grant.role });
    } catch (err) {
      this.deps.log.error('[Relay] tunnel open failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Decide what a connecting client may do. `null` means refuse the channel.
   *
   * Three paths, in order of decreasing trust:
   *   - the confirmed owner, by relay user id;
   *   - a certificate this machine signed, still active in our own table;
   *   - nothing, before the owner id has ever been confirmed — the pre-sharing
   *     behaviour, allowed only until the latch closes.
   */
  private resolveGrant(payload: unknown, principal?: Principal): Grant | null {
    const certificate = (payload as { certificate?: unknown })?.certificate;
    const ownerId = this.deps.grants.ownerUserId();

    if (ownerId && principal?.userId === ownerId) return ownerGrant();

    if (certificate !== undefined && certificate !== null) {
      return this.grantFromCertificate(certificate, principal);
    }

    // No certificate and not the confirmed owner.
    if (ownerId) return null;

    // The owner id has never been confirmed. Before sharing existed every
    // connecting client was the owner by construction, and the relay still
    // only routes a machine's owner here unless a grant exists — so keep that
    // behaviour rather than locking people out on upgrade. The latch is what
    // stops it being a downgrade path once sharing is genuinely in use.
    if (this.deps.grants.enforced()) {
      this.deps.log.warn('[Relay] refusing an unconfirmed-owner channel: grant enforcement is latched on');
      return null;
    }
    return ownerGrant();
  }

  /** Verify a presented certificate and resolve it against our own table. */
  private grantFromCertificate(certificate: unknown, principal?: Principal): Grant | null {
    const machineId = this.deps.machineId();
    if (!machineId || !principal?.userId) return null;

    const parsed = parseCertificate(certificate);
    if (!parsed) {
      this.deps.log.warn('[Relay] rejected a malformed certificate');
      return null;
    }

    const now = this.deps.now();
    const checked = checkCertificate(parsed, {
      machineId,
      relayOrigin: this.deps.relayOrigin(),
      ed25519PubB64: this.deps.identity.ed25519Pub(),
      principalUserId: principal.userId,
      now,
    });
    if (!checked.ok) {
      this.deps.log.warn('[Relay] rejected a certificate', { reason: checked.reason });
      return null;
    }

    // A valid signature is not enough. The certificate is a bearer token
    // otherwise: our own table is the authority on whether the grant still
    // exists, is still active, and still names the same person.
    const stored = this.deps.grants.get(checked.parts.grantId);
    if (!stored || stored.status !== 'active') {
      this.deps.log.warn('[Relay] rejected a certificate for an unknown or inactive grant');
      return null;
    }
    if (stored.granteeUserId !== checked.parts.granteeUserId || stored.role !== checked.parts.role) {
      this.deps.log.warn('[Relay] rejected a certificate that disagrees with its stored grant');
      return null;
    }

    // Scope is bound to the PTY *instance*. sessions.id survives stop/restart,
    // so without this a share of one session would follow the row into
    // whatever it becomes weeks later.
    const live = stored.sessions.filter((s) => this.deps.pty.ptyEpoch(s.sessionId) === s.ptyEpoch);
    if (live.length === 0) {
      this.deps.log.warn('[Relay] certificate is valid but every shared session has been restarted');
      return null;
    }

    // From here on this machine has enforced a certificate, so it must never
    // fall back to "whoever connects is the owner" again.
    this.deps.grants.latch();
    return grantFrom(checked.parts, live.map((s) => s.sessionId));
  }

  /** A sealed frame arrived from a web client. */
  frame(clientId: string, payload: unknown): void {
    const s = this.sessions.get(clientId);
    if (!s) return;
    const frame = payload as SealedFrame;
    if (typeof frame?.n !== 'number' || typeof frame?.ct !== 'string' || frame.n <= s.recvCounter) return;

    let inner: ClientFrame;
    try {
      inner = openJson(s.key, frame);
    } catch {
      this.deps.log.warn('[Relay] dropped an unauthenticatable client frame');
      return;
    }
    s.recvCounter = frame.n;
    this.dispatch(clientId, s, inner);
  }

  /**
   * Route one decrypted client command through the capability gate.
   *
   * The gate is here and nowhere else. Handlers may assume they were permitted
   * and must not re-derive authorization, so there is exactly one place that
   * can be wrong.
   */
  private dispatch(clientId: string, s: ClientSession, inner: ClientFrame): void {
    const command = typeof inner.type === 'string' ? inner.type : '';
    const handler = this.commands[command];
    if (!handler) return;

    const sessionId = typeof inner.sessionId === 'string' ? inner.sessionId : null;
    if (!permits(s.grant, command, sessionId, this.deps.now())) {
      this.sealTo(clientId, { type: 'denied', reason: 'not_permitted', command });
      return;
    }
    handler(clientId, s, inner);
  }

  private handleSessionCreate(clientId: string, s: ClientSession, inner: ClientFrame): void {
    if (typeof inner.groupId !== 'string' || typeof inner.name !== 'string') return;
    const provider = typeof inner.provider === 'string' ? inner.provider : 'claude';
    const isShell = provider === 'shell';
    try {
      this.deps.remote.createSession({
        groupId: inner.groupId,
        name: inner.name.trim() || 'session',
        provider: isShell ? 'claude' : provider,
        launchClaude: !isShell,
      });
      this.sendSessions(clientId, s); // refresh the client's list with the new session
    } catch (err) {
      this.sealTo(clientId, { type: 'error', message: err instanceof Error ? err.message : 'could not create session' });
    }
  }

  private async handleSubscribe(clientId: string, s: ClientSession, inner: ClientFrame): Promise<void> {
    if (typeof inner.sessionId !== 'string') return;
    const sessionId = inner.sessionId;
    s.subs.add(sessionId);
    // Tell the viewer the PTY's current size so it renders TUIs correctly.
    const size = this.deps.pty.getSize(sessionId);
    this.sealTo(clientId, { type: 'terminal:size', sessionId, cols: size.cols, rows: size.rows });

    // Scrollback is not shared. A guest joins at the moment they were let in,
    // not at whatever was on screen before — replaying history would hand over
    // everything typed before the decision to share was made.
    if (s.grant.role !== 'owner') {
      this.sealTo(clientId, {
        type: 'terminal:output',
        sessionId,
        data: '\x1b[2J\x1b[3J\x1b[H── shared from here ──\r\n',
      });
      return;
    }

    // Replay history as RENDERED TEXT (reflow-safe) so a phone can resize the
    // shared terminal without the scrollback garbling. Then live output streams.
    // Chunked so a long scrollback can't put a multi-megabyte frame on the wire
    // (xterm.js carries parser state across writes, so splitting is safe).
    const history = await this.deps.pty.getSerializedBuffer(sessionId);
    for (const data of chunkText(history)) {
      // Re-check every chunk: the client may unsubscribe or drop mid-replay.
      if (!s.subs.has(sessionId) || this.sessions.get(clientId) !== s) return;
      this.sealTo(clientId, { type: 'terminal:output', sessionId, data });
    }
  }

  private handleDirsList(clientId: string, _s: ClientSession, inner: ClientFrame): void {
    // Browse the machine's folders (for creating a group's working dir).
    const base = expandHome(typeof inner.path === 'string' && inner.path ? inner.path : os.homedir());
    try {
      const entries = fs
        .readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
      this.sealTo(clientId, { type: 'dirs', path: base, entries });
    } catch {
      this.sealTo(clientId, { type: 'dirs', path: base, entries: [], error: "can't read this folder" });
    }
  }

  private handleGroupCreate(clientId: string, s: ClientSession, inner: ClientFrame): void {
    if (typeof inner.name !== 'string' || !inner.name.trim()) return;
    try {
      this.deps.remote.createGroup({
        name: inner.name,
        parentId: typeof inner.parentId === 'string' ? inner.parentId : null,
        workingDir: typeof inner.workingDir === 'string' ? expandHome(inner.workingDir) : '',
        color: typeof inner.color === 'string' ? inner.color : '#35c2d1',
      });
      this.sendGroups(clientId, s);
    } catch (err) {
      this.sealTo(clientId, { type: 'error', message: err instanceof Error ? err.message : 'could not create group' });
    }
  }

  /** A web client disconnected — drop its state. */
  closeClient(clientId: string): void {
    if (!this.sessions.delete(clientId)) return;
    this.stopListeningIfIdle();
  }

  /** Tear down every client (agent WebSocket dropped). */
  closeAll(): void {
    for (const clientId of [...this.sessions.keys()]) this.closeClient(clientId);
  }

  /**
   * Revoke a live client's access without waiting for it to disconnect.
   * Returns to DENY_ALL rather than closing, so the guest is told why.
   */
  revokeClient(clientId: string, reason = 'revoked'): void {
    const s = this.sessions.get(clientId);
    if (!s) return;
    s.grant = DENY_ALL;
    s.subs.clear();
    // Sealed: an unsealed "your access ended" is forgeable by the relay, which
    // turns a revocation notice into a clean phishing lever.
    this.sealTo(clientId, { type: 'denied', reason });
  }

  /**
   * Sessions this client may see. A guest is told about its own scope and
   * nothing else — the list is a disclosure, not just a convenience.
   */
  private visibleSessions(grant: Grant): TunnelSessionRow[] {
    const all = this.deps.sessions.getAll().filter((session) => this.deps.pty.isLive(session.id));
    if (grant.sessions === null) return all;
    return all.filter((session) => grant.sessions!.includes(session.id));
  }

  private sendSessions(clientId: string, s: ClientSession): void {
    const isOwner = s.grant.role === 'owner';
    const list = this.visibleSessions(s.grant).map((session) => ({
      id: session.id,
      name: session.name,
      state: session.state,
      groupId: session.groupId,
      // A path is a disclosure about the machine — usernames, client names,
      // directory layout — and a guest has no use for one.
      ...(isOwner ? { workingDir: session.workingDir } : {}),
      provider: session.provider,
      shellType: session.shellType,
    }));
    this.sealTo(clientId, { type: 'sessions', sessions: list });
  }

  private sendGroups(clientId: string, s: ClientSession): void {
    const isOwner = s.grant.role === 'owner';
    // A guest only learns about groups that contain a session it can see.
    const visible = new Set(this.visibleSessions(s.grant).map((session) => session.groupId));
    const groups = this.deps.groups
      .getAll()
      .filter((g) => isOwner || visible.has(g.id))
      .map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        ...(isOwner ? { workingDir: g.workingDir } : {}),
        parentId: g.parentId,
      }));
    this.sealTo(clientId, { type: 'groups', groups });
  }

  private sealTo(clientId: string, obj: unknown): void {
    const s = this.sessions.get(clientId);
    if (!s) return;
    this.route(clientId, sealJson(s.key, s.sendCounter++, obj));
  }
}

/** Commands that name a session, re-exported so callers can reason about scope. */
export { isSessionScoped };
