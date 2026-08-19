/**
 * Relay client (remote hosting, Slice B).
 *
 * Dials OUT to the cloud relay over WSS (no inbound ports) and keeps the
 * machine present. Auth is a challenge/response: the relay sends a nonce, the
 * agent signs it with its Ed25519 identity key, and the relay marks the machine
 * online. Machine linking is a one-time HTTP `POST /link` that returns a code
 * the user claims in the relay's web UI.
 *
 * The wire messages mirror `relay/src/protocol.ts` and `relay/src/ws.ts` — both
 * sides MUST produce identical bytes, so the two small builders below are kept
 * in sync with that file.
 */

import { EventEmitter } from 'events';
import { powerSaveBlocker } from 'electron';
import { WebSocket } from 'ws';
import log from 'electron-log';
import { getPreference, setPreference, deletePreference } from '../../repositories/preferences';
import type { RelayShare, RelayStatus } from '../../../shared/types';
import { ensureIdentity, identityFingerprint, signWithIdentity } from './relay-identity';
import { SessionTunnel, type Principal } from './session-tunnel';
import { defaultDeps } from './session-tunnel-deps';
import { CAP_GRANTS_V1, buildShareCreateMessage } from './grants';
import { ptyManager } from '../../pty-manager';
import { getDatabase } from '../../database';
import {
  clearAllGrants,
  clearPendingRevocation,
  getGrant,
  getOwnerUserId,
  listGrants,
  mintGrant,
  pendingRevocations,
  revokeGrant as revokeGrantLocally,
  setOwnerUserId,
  GRANT_PREF,
} from './grant-store';
import { getInviteScope, recordInviteScope } from './grant-sql';
import type { GrantRole } from './grants';
import { getAllSessions } from '../../repositories/sessions';

/** Session name for the approval prompt, or null if it has since gone. */
function getSessionName(sessionId: string): string | null {
  return getAllSessions().find((s) => s.id === sessionId)?.name ?? null;
}

/** A grant as the relay describes it. Never authorization on its own. */
export interface PendingGrant {
  grantId: string;
  status: 'pending' | 'active' | 'revoked';
  role: GrantRole;
  label: string | null;
  granteeUserId: string;
  granteeLogin: string | null;
  granteeName: string | null;
  /** The invite it came from, so we can recover the session it was offered for. */
  inviteId: string | null;
  createdAt: number;
  expiresAt: number | null;
  /**
   * The lifetime the invite promised. `expiresAt` is NULL until we
   * countersign, so this is the only thing available at the moment of
   * approval — which is the moment it is needed.
   */
  grantTtlSeconds: number | null;
}

/** Fallback when the relay did not state one. Deliberately short. */
const DEFAULT_GRANT_TTL_SECONDS = 4 * 60 * 60;

const PREF_OWNER_USER_ID = GRANT_PREF.ownerUserId;

/**
 * Strip trailing slashes from an origin.
 *
 * This replaced `/\/+$/`, which Sonar reports as a super-linear backtracking
 * risk. To be accurate about it: a single-character-class `+` anchored at the
 * end has no catastrophic-backtracking exposure, so the scanner overstates the
 * original — and the only input here is the user's own configured relay URL
 * anyway. It was changed because a linear scan is the same three lines, needs
 * no argument from anyone reading it later, and does not leave a hotspot to be
 * re-reviewed on every future PR that touches this file.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return value.slice(0, end);
}

/** The relay's claim about who owns this machine. A claim, never proof. */
export interface AssertedOwner {
  userId: string;
  displayName: string | null;
  email: string | null;
}

export type { RelayStatus } from '../../../shared/types';

const DEFAULT_RELAY_URL = 'https://cl-relay.sytanek.tech';

const PREF = {
  enabled: 'relay.enabled',
  url: 'relay.url',
  machineId: 'relay.machineId',
  machineName: 'relay.machineName',
  keepAwake: 'relay.keepAwake',
} as const;

const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 30_000;
/** Back off harder while waiting for the user to claim the link code. */
const UNLINKED_RETRY_MS = 15_000;
// --- wire-format builders (keep in sync with relay/src/protocol.ts) ---
function buildLinkMessage(ed25519PubB64: string, x25519PubB64: string, machineName: string, issuedAt: number): Uint8Array {
  return new TextEncoder().encode(['link:v1', ed25519PubB64, x25519PubB64, machineName, String(issuedAt)].join('\n'));
}
function buildAgentAuthMessage(nonce: string): Uint8Array {
  return new TextEncoder().encode(`agent-auth:v1\n${nonce}`);
}

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private connected = false;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  /** OS "stay awake" assertion id while remote hosting is on (null = released). */
  private powerSaveBlockerId: number | null = null;
  /** An owner id the relay asserted that no human has confirmed yet. */
  private pendingOwner: AssertedOwner | null = null;
  /** Share requests waiting on the owner, keyed by grant id. */
  private readonly pendingGrants = new Map<string, PendingGrant>();
  /** Routes E2E terminal frames to/from web clients (M3). */
  private readonly tunnel = new SessionTunnel(
    (clientId, payload) => this.send({ type: 'to-client', clientId, payload }),
    {
      ...defaultDeps(
        () => stripTrailingSlashes(this.relayUrl),
        () => getPreference(PREF.machineId),
      ),
      // Presence changes are status changes: the owner's surfaces are driven
      // off the same push everything else uses.
      onPresenceChange: () => this.emitStatus(),
    },
  );

  /** Origin of the relay, e.g. `https://relay.example.com`. */
  get relayUrl(): string {
    const stored = getPreference(PREF.url)?.trim();
    if (stored) return stored;
    return DEFAULT_RELAY_URL;
  }

  private get wsUrl(): string {
    const origin = stripTrailingSlashes(this.relayUrl);
    return `${origin.replace(/^http/, 'ws')}/ws`;
  }

  get enabled(): boolean {
    return getPreference(PREF.enabled) === 'true';
  }

  /** Whether to keep the machine awake while remote hosting is on (default true). */
  get keepAwake(): boolean {
    return getPreference(PREF.keepAwake) !== 'false';
  }

  getStatus(): RelayStatus {
    return {
      enabled: this.enabled,
      connected: this.connected,
      linked: !!getPreference(PREF.machineId),
      machineId: getPreference(PREF.machineId),
      machineName: getPreference(PREF.machineName),
      relayUrl: this.relayUrl,
      fingerprint: identityFingerprint(),
      keepAwake: this.keepAwake,
      ownerUserId: getOwnerUserId(),
      pendingOwner: this.pendingOwner
        ? { ...this.pendingOwner, isChange: !!getOwnerUserId() }
        : null,
      attachedGuests: this.tunnel.attachedGuests(),
      pendingShares: this.getPendingGrants().map((g) => {
        const scope = g.inviteId ? getInviteScope(getDatabase(), g.inviteId) : null;
        return {
          grantId: g.grantId,
          role: g.role,
          granteeLogin: g.granteeLogin,
          granteeName: g.granteeName,
          createdAt: g.createdAt,
          sessionId: scope?.sessionId ?? null,
          sessionName: scope ? (getSessionName(scope.sessionId) ?? null) : null,
        };
      }),
    };
  }

  /** Toggle the keep-awake behavior; applies immediately if remote hosting is on. */
  setKeepAwake(on: boolean): void {
    setPreference(PREF.keepAwake, on ? 'true' : 'false');
    if (this.enabled && on) this.startKeepAwake();
    else this.stopKeepAwake();
    this.emitStatus();
  }

  /**
   * Hold an OS power assertion so the machine stays reachable — otherwise it
   * idle-sleeps, the agent socket dies, and no one can connect until it's woken
   * locally. `prevent-app-suspension` keeps the system awake but lets the
   * display sleep. (Note: does not override closed-lid sleep on macOS battery.)
   */
  private startKeepAwake(): void {
    if (!this.keepAwake || this.powerSaveBlockerId !== null) return;
    this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    log.info('[Relay] keep-awake engaged (prevent-app-suspension)');
  }

  private stopKeepAwake(): void {
    if (this.powerSaveBlockerId === null) return;
    if (powerSaveBlocker.isStarted(this.powerSaveBlockerId)) powerSaveBlocker.stop(this.powerSaveBlockerId);
    this.powerSaveBlockerId = null;
    log.info('[Relay] keep-awake released');
  }

  setRelayUrl(url: string): void {
    const trimmed = stripTrailingSlashes(url.trim());
    if (!URL.canParse(trimmed)) throw new Error('Invalid relay URL');
    const changed = trimmed !== stripTrailingSlashes(this.relayUrl);
    setPreference(PREF.url, trimmed);
    if (changed) {
      // Certificates carry their relay origin in the signed bytes and are
      // checked against it at dispatch, so every existing grant is now
      // unusable. Keeping the rows would leave ghosts in the owner's settings
      // that can never be honoured. The user ids came from the old relay too.
      clearAllGrants();
      deletePreference(PREF_OWNER_USER_ID);
      log.info('[Relay] relay URL changed — cleared grants and the confirmed owner id');
    }
    this.emitStatus();
    if (this.enabled) this.reconnectNow();
  }

  /** Turn remote hosting on: create identity if needed and start connecting. */
  enable(): void {
    setPreference(PREF.enabled, 'true');
    ensureIdentity();
    this.startKeepAwake();
    this.emitStatus();
    this.connect();
  }

  /** Turn remote hosting off and disconnect. */
  disable(): void {
    setPreference(PREF.enabled, 'false');
    this.stopKeepAwake();
    this.teardown();
    this.emitStatus();
  }

  /** Resume on app launch if the user previously enabled it. */
  startIfEnabled(): void {
    if (this.enabled) {
      this.startKeepAwake();
      this.connect();
    }
  }

  /**
   * Request a link code from the relay. Requires an identity (created here if
   * absent). The returned code is shown to the user, who claims it in the relay
   * web UI to bind this machine to their account.
   */
  async generateLinkCode(machineName: string): Promise<{ code: string; expiresAt: number }> {
    const name = machineName.trim() || 'My Machine';
    const identity = ensureIdentity();
    setPreference(PREF.machineName, name);

    const issuedAt = Date.now();
    const signature = signWithIdentity(
      buildLinkMessage(identity.ed25519Pub, identity.x25519Pub, name, issuedAt),
    ).toString('base64');

    const res = await fetch(`${stripTrailingSlashes(this.relayUrl)}/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        machineName: name,
        ed25519Pub: identity.ed25519Pub,
        x25519Pub: identity.x25519Pub,
        issuedAt,
        signature,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const suffix = detail ? `: ${detail}` : '';
      throw new Error(`relay rejected link request (${res.status})${suffix}`);
    }
    const body = (await res.json()) as { code: string; expiresAt: number };

    // Once enabled, keep a connection attempt alive so we go online the moment
    // the user claims the code.
    if (this.enabled) this.connect();
    return body;
  }

  // --- connection lifecycle ---

  private connect(): void {
    if (this.connecting || this.connected || !this.enabled) return;
    this.connecting = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this.connecting = false;
      log.warn('[Relay] failed to open socket (will retry):', err instanceof Error ? err.message : err);
      this.scheduleReconnect(RECONNECT_BASE_MS);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      log.info('[Relay] socket open; awaiting challenge');
    });

    ws.on('message', (data) => {
      void this.handleMessage(data.toString());
    });

    ws.on('close', (code) => {
      this.connecting = false;
      const wasConnected = this.connected;
      this.connected = false;
      this.stopPing();
      this.ws = null;
      if (wasConnected) this.emitStatus();

      if (!this.enabled) return;
      if (code === 4404) {
        // Unknown machine: not linked yet (or unlinked). Clear stale id and
        // retry slowly while the user finishes claiming the code.
        deletePreference(PREF.machineId);
        this.emitStatus();
        this.scheduleReconnect(UNLINKED_RETRY_MS);
      } else {
        this.reconnectAttempts += 1;
        this.scheduleReconnect(Math.min(RECONNECT_BASE_MS * this.reconnectAttempts, RECONNECT_MAX_MS));
      }
    });

    ws.on('error', (err: Error) => {
      // Transient (offline, DNS). Reconnect is driven by 'close'. Only re-emit
      // if someone is listening — a listenerless 'error' re-throws (BDHLNDR-41).
      log.warn('[Relay] socket error (will retry):', err.message);
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: {
      type?: string;
      nonce?: string;
      machineId?: string;
      clientId?: string;
      payload?: unknown;
      principal?: Principal;
      owner?: AssertedOwner | null;
      grants?: PendingGrant[];
      grantId?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // M3 brokering: the relay routes web-client frames to us by client id.
    if (msg.clientId) {
      if (msg.type === 'client:open') this.tunnel.open(msg.clientId, msg.payload, msg.principal);
      else if (msg.type === 'from-client') this.tunnel.frame(msg.clientId, msg.payload);
      else if (msg.type === 'client:closed') this.tunnel.closeClient(msg.clientId);
      return;
    }

    if (msg.type === 'challenge' && msg.nonce) {
      try {
        const signature = signWithIdentity(buildAgentAuthMessage(msg.nonce)).toString('base64');
        const identity = ensureIdentity();
        // Tell the relay this build enforces grant certificates. It refuses to
        // route a guest to any machine that has not said so, because an older
        // build ignores the certificate entirely and would hand that guest
        // every command.
        this.send({ type: 'agent:auth', ed25519Pub: identity.ed25519Pub, signature, caps: [CAP_GRANTS_V1] });
      } catch (err) {
        log.error('[Relay] failed to answer challenge:', err instanceof Error ? err.message : err);
        this.ws?.close();
      }
      return;
    }

    if (this.handleShareMessage(msg)) return;

    if (msg.type === 'agent:ready') {
      this.connecting = false;
      this.connected = true;
      this.reconnectAttempts = 0;
      if (msg.machineId) setPreference(PREF.machineId, msg.machineId);
      this.noteAssertedOwner(msg.owner ?? null);
      this.startPing();
      log.info('[Relay] online', { machineId: msg.machineId });
      this.emitStatus();
    }

    // 'pong' and future M3 frames land here.
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer || !this.enabled) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private reconnectNow(): void {
    this.teardown();
    this.connect();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private teardown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    // The relay brokers client sessions over this socket; if it drops, they're
    // all gone (and their PTY listeners must be released).
    this.tunnel.closeAll();
    this.connecting = false;
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close(1000, 'client shutdown');
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
  }

  // --- sharing (M5.2) ---

  /**
   * The relay's sharing messages. Split out of `handleMessage` so that method
   * stays one dispatch rather than a growing pile of branches.
   *
   * Returns whether the message was one of ours.
   */
  private handleShareMessage(msg: { type?: string; grants?: PendingGrant[]; grantId?: string }): boolean {
    // A guest redeemed an invite, or we just reconnected and the relay is
    // telling us everything it holds.
    if (msg.type === 'share:pending' && msg.grants) {
      this.notePendingGrants(msg.grants);
      return true;
    }
    if (msg.type === 'share:sync' && msg.grants) {
      this.reconcileGrants(msg.grants);
      return true;
    }
    // Revoked elsewhere — by the owner on another device, or by the guest
    // handing access back.
    if (msg.type === 'grant:revoked' && msg.grantId) {
      revokeGrantLocally(msg.grantId);
      clearPendingRevocation(msg.grantId);
      this.pendingGrants.delete(msg.grantId);
      this.tunnel.revokeGrant(msg.grantId, 'revoked');
      this.emit('grants-changed');
      return true;
    }
    return false;
  }

  /**
   * Offer a share of one session, returning the link to send.
   *
   * **The URL is composed here, never by the relay.** If the relay authored it,
   * it could put its own fingerprint in the `#fp=` fragment and serve the
   * matching public key, so the guest's three-way check would agree perfectly
   * and manufacture a false "verified". The relay only ever returns the code.
   */
  async createShareInvite(input: {
    sessionId: string;
    expectedGithubLogin: string | null;
    role: GrantRole;
    grantTtlSeconds: number;
    inviteTtlSeconds: number;
  }): Promise<{ code: string; url: string; expiresAt: number }> {
    const machineId = getPreference(PREF.machineId);
    if (!machineId) throw new Error('this machine is not linked');

    // Capture the PTY instance now, so the approval prompt later refers to the
    // terminal the owner actually meant rather than whatever the row became.
    const ptyEpoch = ptyManager.getSession(input.sessionId)?.spawnedAt;
    if (ptyEpoch === undefined) throw new Error('that session is not running');

    const issuedAt = Date.now();
    const origin = stripTrailingSlashes(this.relayUrl);
    const signature = signWithIdentity(
      buildShareCreateMessage({
        machineId,
        expectedGithubLogin: input.expectedGithubLogin ?? '',
        role: input.role,
        grantTtlSeconds: input.grantTtlSeconds,
        inviteTtlSeconds: input.inviteTtlSeconds,
        issuedAt,
      }),
    ).toString('base64');

    const res = await fetch(`${origin}/api/machines/${machineId}/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedGithubLogin: input.expectedGithubLogin,
        role: input.role,
        grantTtlSeconds: input.grantTtlSeconds,
        inviteTtlSeconds: input.inviteTtlSeconds,
        issuedAt,
        signature,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const suffix = detail ? `: ${detail}` : '';
      throw new Error(`relay rejected the share request (${res.status})${suffix}`);
    }
    const body = (await res.json()) as { inviteId: string; code: string; expiresAt: number };

    recordInviteScope(
      getDatabase(),
      body.inviteId,
      { sessionId: input.sessionId, ptyEpoch, role: input.role },
      issuedAt,
    );

    const fingerprint = identityFingerprint();
    // The fragment never reaches the relay — that is what makes it usable as
    // out-of-band provenance for the machine the guest is about to trust.
    const fragment = fingerprint ? `#fp=${encodeURIComponent(fingerprint)}` : '';
    const url = `${origin}/i/${body.code}${fragment}`;
    log.info('[Relay] share invite created', { addressed: !!input.expectedGithubLogin });
    return { code: body.code, url, expiresAt: body.expiresAt };
  }

  /** Every grant this machine has issued, for the owner's settings list. */
  listShares(): RelayShare[] {
    return listGrants().map((g) => ({
      grantId: g.id,
      role: g.role,
      status: g.status,
      granteeLogin: g.granteeLogin,
      createdAt: g.createdAt,
      expiresAt: g.expiresAt,
      // Surfaced so the UI can say "Revoked — takes effect when this machine
      // reconnects" rather than implying it already has.
      revokePending: g.revokePending,
      sessionIds: g.sessions.map((x) => x.sessionId),
    }));
  }

  /** Grants the relay says exist that this machine has not answered yet. */
  getPendingGrants(): PendingGrant[] {
    return [...this.pendingGrants.values()];
  }

  private notePendingGrants(grants: PendingGrant[]): void {
    let added = false;
    for (const g of grants) {
      if (g.status !== 'pending') continue;
      // Already answered on this machine — a duplicate share:pending after a
      // reconnect must not re-prompt the owner for something they decided.
      if (getGrant(g.grantId)) continue;
      if (this.pendingGrants.has(g.grantId)) continue;
      this.pendingGrants.set(g.grantId, g);
      added = true;
      this.emit('join-request', g);
    }
    if (added) this.emit('grants-changed');
  }

  /**
   * Reconcile against what the relay says it holds, then assert our own view.
   *
   * Local status is the authority on revocation, so this is not a merge: we
   * take the relay's list of *pending* requests (which only it can know about),
   * flush anything we revoked while offline, and then tell it the set of
   * grants we still consider live. Anything else it holds for this machine is
   * a ghost — from a relay restore, or from a revocation it never heard.
   */
  private reconcileGrants(relayGrants: PendingGrant[]): void {
    this.pendingGrants.clear();
    this.notePendingGrants(relayGrants);

    // Revocations queued while we were offline. Sending share:reconcile below
    // would already drop them, but an explicit revoke is clearer in the
    // relay's logs and does not depend on the reconcile arriving.
    for (const grantId of pendingRevocations()) {
      this.send({ type: 'share:deny', grantId, reason: 'revoked' });
      clearPendingRevocation(grantId);
    }

    const active = listGrants()
      .filter((g) => g.status === 'active')
      .map((g) => g.id);
    this.send({ type: 'share:reconcile', activeGrantIds: active });
    this.emit('grants-changed');
  }

  /**
   * The owner approved a request. Mint a certificate over the sessions they
   * chose and hand it to the relay.
   *
   * `ptyEpoch` is captured HERE, at the moment of consent, not at connection
   * time — the grant is for the terminal the owner was looking at, and
   * `sessions.id` survives a restart into something else entirely.
   */
  approveGrant(grantId: string, sessionIds?: string[]): void {
    const pending = this.pendingGrants.get(grantId);
    if (!pending) throw new Error('no such pending share request');
    // Default to the session the invite was offered for. The relay never knew
    // it — no session id ever reaches it — so this comes from our own table.
    const scope = pending.inviteId ? getInviteScope(getDatabase(), pending.inviteId) : null;
    const fromInvite = scope ? [scope.sessionId] : [];
    const chosen = sessionIds?.length ? sessionIds : fromInvite;
    if (chosen.length === 0) throw new Error('a share must name at least one session');

    const machineId = getPreference(PREF.machineId);
    if (!machineId) throw new Error('this machine is not linked');

    const sessions = chosen.map((sessionId) => {
      const ptyEpoch = ptyManager.getSession(sessionId)?.spawnedAt;
      if (ptyEpoch === undefined) throw new Error(`session ${sessionId} is not running`);
      return { sessionId, ptyEpoch };
    });

    // From the invite the owner created, not from `expiresAt` — that is NULL
    // until we countersign, which is exactly the moment we are in now.
    //
    // `??`, not `||`: 0 is a value the owner chose (until revoked), and `||`
    // would quietly turn it back into four hours.
    const ttlSeconds = pending.grantTtlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
    const { certificate, grant } = mintGrant({
      grantId,
      machineId,
      relayOrigin: stripTrailingSlashes(this.relayUrl),
      granteeUserId: pending.granteeUserId,
      granteeLogin: pending.granteeLogin,
      role: pending.role,
      sessions,
      ttlSeconds,
    });

    this.send({ type: 'share:bind', grantId, certificate, expiresAt: grant.expiresAt });
    this.pendingGrants.delete(grantId);
    log.info('[Relay] share approved', { grantId, sessions: sessions.length });
    this.emit('grants-changed');
  }

  /** The owner said no. Nothing is minted, so there is nothing to revoke. */
  denyGrant(grantId: string, reason = 'declined'): void {
    this.pendingGrants.delete(grantId);
    this.send({ type: 'share:deny', grantId, reason });
    log.info('[Relay] share denied', { grantId });
    this.emit('grants-changed');
  }

  /**
   * End an active grant. Local status is the authority, so this takes effect
   * at the guest's next `client:open` whether or not the relay ever hears —
   * and the queue makes revoking while disconnected honest rather than a lie.
   */
  revokeGrant(grantId: string): void {
    revokeGrantLocally(grantId);
    this.tunnel.revokeGrant(grantId, 'revoked');
    if (this.connected) {
      this.send({ type: 'share:deny', grantId, reason: 'revoked' });
      clearPendingRevocation(grantId);
    }
    log.info('[Relay] grant revoked', { grantId, queued: !this.connected });
    this.emit('grants-changed');
  }

  // --- owner confirmation (design §3) ---

  /**
   * The relay has told us who it thinks owns this machine.
   *
   * Nothing is trusted here. `agent:ready` carries only a `machineId`, so the
   * desktop has no independent way to learn its own relay user id — which
   * means auto-accepting this would let whoever runs the relay name themselves
   * the owner and acquire owner capability on a machine. A human confirms it
   * once, and any later change needs a fresh confirmation.
   */
  private noteAssertedOwner(owner: AssertedOwner | null): void {
    if (!owner?.userId) return;
    const confirmed = getOwnerUserId();
    if (confirmed === owner.userId) {
      this.pendingOwner = null;
      return;
    }
    this.pendingOwner = owner;
    log.info('[Relay] awaiting owner confirmation', { changed: !!confirmed });
    this.emit('owner-confirmation', { owner, isChange: !!confirmed });
  }

  /** The owner id awaiting a human decision, if any. */
  getPendingOwner(): { owner: AssertedOwner; isChange: boolean } | null {
    if (!this.pendingOwner) return null;
    return { owner: this.pendingOwner, isChange: !!getOwnerUserId() };
  }

  /**
   * The human said yes. Any grant minted under a previous owner is void — it
   * names a user id from a relationship that no longer holds.
   */
  confirmOwner(userId: string): void {
    if (!this.pendingOwner || this.pendingOwner.userId !== userId) {
      throw new Error('no such owner confirmation is pending');
    }
    const previous = getOwnerUserId();
    if (previous && previous !== userId) clearAllGrants();
    setOwnerUserId(userId);
    this.pendingOwner = null;
    log.info('[Relay] owner confirmed');
    this.emitStatus();
  }

  /**
   * The human said no. Remote hosting goes off rather than merely dismissing:
   * a machine linked to an account the owner does not recognise is a machine
   * that should not be reachable while they work out why.
   */
  rejectOwner(): void {
    this.pendingOwner = null;
    log.warn('[Relay] owner confirmation rejected — disabling remote hosting');
    this.disable();
  }

  /** Full shutdown for app quit. */
  stop(): void {
    this.stopKeepAwake();
    this.teardown();
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }
}
