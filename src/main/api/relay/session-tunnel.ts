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
  /** A point in the output stream that survives the scrollback cap trimming. */
  scrollbackMark(id: string): number | null;
  /** Rendered history from `mark` onward — never the whole scrollback. */
  getSerializedBufferSince(id: string, mark: number): Promise<string>;
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
  /**
   * Called whenever the set of attached guests changes.
   *
   * Presence is a hard requirement, not a nicety: silent read access to a live
   * terminal is the same class of harm as silent write access, so the owner
   * must be able to see who is watching without going looking.
   */
  onPresenceChange?: () => void;
  /**
   * A guest asked to be fitted to their screen. A notification, not an action:
   * the owner's renderer turns it into a prompt and performs the resize itself
   * on accept, so declining is indistinguishable from silence.
   */
  onResizeRequest?: (request: GuestResizeRequest) => void;
  /** The relay origin this agent is connected to, for certificate binding. */
  relayOrigin(): string;
  /** This machine's id as the relay knows it, or null before linking. */
  machineId(): string | null;
  now(): number;
}

/** The relay-asserted identity of a connecting socket. Never authorization. */
export interface Principal {
  userId: string;
  githubLogin?: string | null;
  displayName?: string | null;
}

/**
 * A guest asking for a session to be resized to fit their screen. A guest
 * never sends `terminal:resize` — a phone must not reflow the owner's
 * terminal — so this carries the ask, and nothing happens until they agree.
 */
export interface GuestResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
  /** Who is asking, for the prompt. Relay-asserted; never authorization. */
  login: string | null;
  displayName: string | null;
}

/** One guest currently attached, as the owner's UI needs to see them. */
export interface AttachedGuest {
  clientId: string;
  grantId: string | null;
  role: string;
  login: string | null;
  displayName: string | null;
  /** The sessions they are watching right now, not merely entitled to. */
  sessionIds: string[];
}

interface ClientSession {
  key: Buffer;
  sendCounter: number;
  recvCounter: number;
  /** Session ids this client is streaming. */
  subs: Set<string>;
  /** What this client may do. Starts at DENY_ALL and is never widened later. */
  grant: Grant;
  /** Who the relay says this is, for presence. Never authorization. */
  principal: Principal | null;
  /**
   * Per-session point in the output stream this client's share began at, so a
   * guest re-attaching is replayed what it has already been shown rather than
   * being wiped back to a blank screen (#169). Empty for the owner, who gets
   * the whole scrollback instead.
   */
  marks: Map<string, number>;
  /** When this client last asked to be fitted to its screen. See the throttle. */
  lastResizeAsk: number;
}

/**
 * The shortest gap between two of one client's resize requests: each raises a
 * prompt on the owner's screen, and one a guest can raise at will makes the
 * desktop unusable. The web client waits far longer before offering it again.
 */
const RESIZE_ASK_INTERVAL_MS = 10_000;

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

/** What a connecting client may do, and where its view of each session starts. */
interface ResolvedGrant {
  grant: Grant;
  marks: Map<string, number>;
}

/** One grant's share window: where each session's replay starts, and until when. */
interface ShareWindow {
  /**
   * The grant's expiry, carried so the entry can be swept.
   *
   * Revocation reaches this map through `revokeGrant`, but expiry does not:
   * a grant that is approved, never connected to, and simply runs out leaves
   * no client behind to notice, so nothing would ever delete it.
   */
  expiresAt: number;
  marks: Map<string, number>;
}

export class SessionTunnel {
  private readonly sessions = new Map<string, ClientSession>();
  /**
   * grantId → where each of its sessions' output the share began at (#169).
   *
   * Deliberately in memory rather than in `relay_grants`: a mark indexes into
   * a PTY instance's live output, and a grant is bound to that instance by
   * `ptyEpoch`, so neither can outlive this process. Persisting it would
   * create a number that survives the buffer it points into.
   */
  private readonly shareMarks = new Map<string, ShareWindow>();
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
      if (typeof inner.sessionId === 'string' && s.subs.delete(inner.sessionId) && s.grant.role !== 'owner') {
        this.deps.onPresenceChange?.();
      }
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
    'terminal:resize-request': (_clientId, s, inner) => this.handleResizeRequest(s, inner),
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
    const now = this.deps.now();
    for (const [clientId, s] of this.sessions) {
      if (!s.subs.has(sessionId)) continue;
      // Re-check the grant on every frame, not just at subscribe time.
      // `permits()` gates INBOUND commands; without this an expired or revoked
      // guest would keep RECEIVING live output for as long as their socket
      // stayed open — the stream is the thing being protected, so the check
      // belongs where the data leaves.
      if (!permits(s.grant, 'terminal:subscribe', sessionId, now)) {
        this.expireClient(clientId, s, now);
        continue;
      }
      send(clientId);
    }
  }

  /** Stop streaming to a client whose grant has lapsed, and tell it why. */
  private expireClient(clientId: string, s: ClientSession, now: number): void {
    if (s.grant.role === 'owner') return;
    // Do NOT infer the reason from the timestamp alone: DENY_ALL carries
    // `expiresAt: 0`, so a revoked client would be told its access "expired" —
    // a different and misleading story. A grant that still holds capabilities
    // and has run out of clock genuinely expired; one stripped of them was
    // taken away.
    const ranOut = s.grant.caps.length > 0 && s.grant.expiresAt <= now;
    const reason = ranOut ? 'expired' : 'revoked';
    // Both endings are terminal for the grant — an expired certificate never
    // verifies again — so its share window goes with it rather than sitting in
    // the map for as long as the app runs.
    if (s.grant.grantId) this.shareMarks.delete(s.grant.grantId);
    s.subs.clear();
    s.grant = DENY_ALL;
    this.sealTo(clientId, { type: 'denied', reason });
    this.deps.onPresenceChange?.();
    this.deps.log.info('[Relay] stopped streaming to a lapsed guest', { clientId, reason });
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
      this.sweepShareWindows();

      const resolved = this.resolveGrant(payload, principal);
      if (resolved === null) {
        this.deps.log.warn('[Relay] refusing a channel with no usable grant', { clientId });
        // Unsealed: no key exists yet, and there is nothing secret in it.
        this.route(clientId, { type: 'denied', reason: 'not_authorized' });
        return;
      }

      const { grant, marks } = resolved;

      // A per-channel ephemeral keypair (see e2e.ts) — never the machine's
      // long-lived X25519 key, which would make this exchange replayable.
      const { sharedSecret, ephemeralPubB64 } = deriveEphemeral(
        new Uint8Array(Buffer.from(clientX25519Pub, 'base64')),
      );
      const key = deriveSessionKey(sharedSecret);
      const signature = this.deps.identity.sign(buildHandshakeProof(clientX25519Pub, ephemeralPubB64)).toString('base64');

      const session: ClientSession = {
        key,
        sendCounter: 0,
        recvCounter: -1,
        subs: new Set(),
        grant,
        principal: principal ?? null,
        marks,
        lastResizeAsk: 0,
      };
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
      if (grant.role !== 'owner') this.deps.onPresenceChange?.();
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
  private resolveGrant(payload: unknown, principal?: Principal): ResolvedGrant | null {
    const certificate = (payload as { certificate?: unknown })?.certificate;
    const ownerId = this.deps.grants.ownerUserId();

    // The owner is replayed the whole scrollback, so there is no window to
    // mark — hence an empty mark map on both owner branches.
    if (ownerId && principal?.userId === ownerId) return { grant: ownerGrant(), marks: new Map() };

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
    return { grant: ownerGrant(), marks: new Map() };
  }

  /** Verify a presented certificate and resolve it against our own table. */
  private grantFromCertificate(certificate: unknown, principal?: Principal): ResolvedGrant | null {
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
    // The share window this grant was approved at, per session. Absent when
    // the grant was minted without one; `shareMark` then starts the window at
    // first attach rather than replaying anything the guest was not shown.
    const recorded = this.shareMarks.get(checked.parts.grantId)?.marks;
    const marks = new Map<string, number>();
    for (const { sessionId } of live) {
      const mark = recorded?.get(sessionId);
      if (mark !== undefined) marks.set(sessionId, mark);
    }
    return { grant: grantFrom(checked.parts, live.map((s) => s.sessionId)), marks };
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
      // A refused COMMAND is not an ended SESSION. These were one frame type
      // once, and the guest client — reasonably — read every `denied` as "you
      // are out", so a single unpermitted command told someone their access
      // had been revoked. Separate types, separate meanings.
      this.sealTo(clientId, { type: 'command:denied', reason: 'not_permitted', command });
      this.deps.log.warn('[Relay] refused a command', { clientId, command, role: s.grant.role });
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

  /**
   * Record where a grant's view of each session starts — called at the moment
   * of consent, from the same place that captures `ptyEpoch`.
   *
   * Taken at approval rather than at first attach so the guest's first view
   * covers the whole window they were let into, not just whatever happened
   * after they got round to opening the link.
   */
  noteShareMarks(grantId: string, marks: { sessionId: string; mark: number }[], expiresAt: number): void {
    this.sweepShareWindows();
    const window = this.shareMarks.get(grantId) ?? { expiresAt, marks: new Map<string, number>() };
    for (const { sessionId, mark } of marks) {
      // First write wins. A second call for a session already recorded would
      // move that window FORWARD, hiding everything produced between the two
      // calls from a guest who is entitled to it — and a window that only ever
      // moves forward is the bug this whole change exists to fix. New sessions
      // are added; recorded ones are left where they are.
      if (!window.marks.has(sessionId)) window.marks.set(sessionId, mark);
    }
    this.shareMarks.set(grantId, window);
  }

  /**
   * Drop windows whose grants have run out.
   *
   * On write and on open rather than on a timer: both are the moments the map
   * is about to be used, and a grant that expired with nobody attached has no
   * client left to carry it out of here any other way.
   */
  private sweepShareWindows(): void {
    const now = this.deps.now();
    for (const [grantId, window] of this.shareMarks) {
      if (window.expiresAt <= now) this.shareMarks.delete(grantId);
    }
  }

  /**
   * Where this client's view of `sessionId` starts, or null if there is
   * nothing to replay from.
   *
   * A missing mark is not treated as position zero — that would replay the
   * entire scrollback to a guest, which is the one thing this must never do.
   * It starts the window here instead, so this attach shows nothing extra and
   * every later one is continuous.
   */
  private shareMark(s: ClientSession, sessionId: string): number | null {
    const known = s.marks.get(sessionId);
    if (known !== undefined) return known;

    const here = this.deps.pty.scrollbackMark(sessionId);
    if (here === null) return null;
    s.marks.set(sessionId, here);
    if (s.grant.grantId) this.noteShareMarks(s.grant.grantId, [{ sessionId, mark: here }], s.grant.expiresAt);
    return here;
  }

  private async handleSubscribe(clientId: string, s: ClientSession, inner: ClientFrame): Promise<void> {
    if (typeof inner.sessionId !== 'string') return;
    const sessionId = inner.sessionId;
    s.subs.add(sessionId);
    if (s.grant.role !== 'owner') this.deps.onPresenceChange?.();
    // Tell the viewer the PTY's current size so it renders TUIs correctly.
    const size = this.deps.pty.getSize(sessionId);
    this.sealTo(clientId, { type: 'terminal:size', sessionId, cols: size.cols, rows: size.rows });

    // Scrollback from before the share is never sent: a guest joins at the
    // moment they were let in, and replaying the buffer would hand over
    // everything typed before the decision to share was made.
    //
    // What IS replayed is the window since that moment. Sending nothing on
    // every attach — which is what this did — meant a guest who stepped away
    // to their own session and came back found the shared one wiped, and had
    // no way to get back what they had already been shown (#169).
    if (s.grant.role !== 'owner') {
      const mark = this.shareMark(s, sessionId);
      this.sealTo(clientId, {
        type: 'terminal:output',
        sessionId,
        data: '\x1b[2J\x1b[3J\x1b[H── shared from here ──\r\n',
      });
      if (mark === null) return;
      const since = await this.deps.pty.getSerializedBufferSince(sessionId, mark);
      for (const data of chunkText(since)) {
        // Re-check every chunk: the client may unsubscribe or drop mid-replay.
        if (!s.subs.has(sessionId) || this.sessions.get(clientId) !== s) return;
        this.sealTo(clientId, { type: 'terminal:output', sessionId, data });
      }
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

  /**
   * A guest asked to be fitted to their screen. Nothing is resized here: the
   * ask goes to the owner's UI and dies there if they say no. The size is
   * clamped, and scoped to a session this client is actually watching.
   */
  private handleResizeRequest(s: ClientSession, inner: ClientFrame): void {
    const sessionId = inner.sessionId;
    const size = sanitizeSize(inner.cols, inner.rows);
    if (typeof sessionId !== 'string' || !size || !s.subs.has(sessionId)) return;

    const now = this.deps.now();
    if (now - s.lastResizeAsk < RESIZE_ASK_INTERVAL_MS) {
      this.deps.log.warn('[Relay] dropped a repeated resize request', { sessionId });
      return;
    }
    s.lastResizeAsk = now;
    this.deps.onResizeRequest?.({
      sessionId,
      cols: size.cols,
      rows: size.rows,
      login: s.principal?.githubLogin ?? null,
      displayName: s.principal?.displayName ?? null,
    });
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
    const was = this.sessions.get(clientId);
    if (!this.sessions.delete(clientId)) return;
    this.stopListeningIfIdle();
    // Detach is as load-bearing as attach: an owner who never sees someone
    // leave cannot tell watching from watched-once.
    if (was && was.grant.role !== 'owner') this.deps.onPresenceChange?.();
  }

  /** Tear down every client (agent WebSocket dropped). */
  closeAll(): void {
    for (const clientId of [...this.sessions.keys()]) this.closeClient(clientId);
  }

  /**
   * Revoke a live client's access without waiting for it to disconnect.
   * Returns to DENY_ALL rather than closing, so the guest is told why.
   *
   * The `ClientSession` deliberately stays in the map. It still holds the key
   * the denial is sealed with, and the socket is still live — dropping it here
   * would mean the guest's next frame arrived on an unknown client id and were
   * silently ignored, which reads as a network fault rather than a decision.
   * It keeps the shared PTY listener attached until the client actually
   * disconnects; `subs` is cleared, so `fanOut` never calls back for it.
   */
  /**
   * Revoke every live client holding `grantId`.
   *
   * Keyed by grant rather than by client because one person may have several
   * browsers open under one grant, and revoking has to reach all of them —
   * missing one would leave a guest still watching a terminal the owner
   * believes they have been removed from.
   */
  revokeGrant(grantId: string, reason = 'revoked'): void {
    // The share window dies with the grant. Keeping it would mean a later
    // grant reusing this id — or a re-approval — inheriting a start point from
    // access that was taken away.
    this.shareMarks.delete(grantId);
    for (const [clientId, s] of this.sessions) {
      if (s.grant.grantId === grantId) this.revokeClient(clientId, reason);
    }
  }

  revokeClient(clientId: string, reason = 'revoked'): void {
    const s = this.sessions.get(clientId);
    if (!s) return;
    s.grant = DENY_ALL;
    s.subs.clear();
    this.deps.onPresenceChange?.();
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

  /**
   * Guests currently attached, for the owner's presence surfaces.
   *
   * Reports what each guest is actually WATCHING (`subs`), not merely what
   * they could watch — "dana-k is here" and "dana-k is looking at this
   * terminal right now" are different claims and the second is the one that
   * matters.
   */
  attachedGuests(): AttachedGuest[] {
    const out: AttachedGuest[] = [];
    for (const [clientId, s] of this.sessions) {
      if (s.grant.role === 'owner') continue;
      out.push({
        clientId,
        grantId: s.grant.grantId,
        role: s.grant.role,
        login: s.principal?.githubLogin ?? null,
        displayName: s.principal?.displayName ?? null,
        sessionIds: [...s.subs],
      });
    }
    return out;
  }

  private sealTo(clientId: string, obj: unknown): void {
    const s = this.sessions.get(clientId);
    if (!s) return;
    this.route(clientId, sealJson(s.key, s.sendCounter++, obj));
  }
}

/** Commands that name a session, re-exported so callers can reason about scope. */
export { isSessionScoped };
