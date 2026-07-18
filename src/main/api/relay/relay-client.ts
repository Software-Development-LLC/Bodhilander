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
import type { RelayStatus } from '../../../shared/types';
import { ensureIdentity, identityFingerprint, signWithIdentity } from './relay-identity';
import { SessionTunnel } from './session-tunnel';

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
  /** Routes E2E terminal frames to/from web clients (M3). */
  private readonly tunnel = new SessionTunnel((clientId, payload) => this.send({ type: 'to-client', clientId, payload }));

  /** Origin of the relay, e.g. `https://relay.example.com`. */
  get relayUrl(): string {
    const stored = getPreference(PREF.url)?.trim();
    if (stored) return stored;
    return DEFAULT_RELAY_URL;
  }

  private get wsUrl(): string {
    const origin = this.relayUrl.replace(/\/+$/, '');
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
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!URL.canParse(trimmed)) throw new Error('Invalid relay URL');
    setPreference(PREF.url, trimmed);
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

    const res = await fetch(`${this.relayUrl.replace(/\/+$/, '')}/link`, {
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
    let msg: { type?: string; nonce?: string; machineId?: string; clientId?: string; payload?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // M3 brokering: the relay routes web-client frames to us by client id.
    if (msg.clientId) {
      if (msg.type === 'client:open') this.tunnel.open(msg.clientId, msg.payload);
      else if (msg.type === 'from-client') this.tunnel.frame(msg.clientId, msg.payload);
      else if (msg.type === 'client:closed') this.tunnel.closeClient(msg.clientId);
      return;
    }

    if (msg.type === 'challenge' && msg.nonce) {
      try {
        const signature = signWithIdentity(buildAgentAuthMessage(msg.nonce)).toString('base64');
        const identity = ensureIdentity();
        this.send({ type: 'agent:auth', ed25519Pub: identity.ed25519Pub, signature });
      } catch (err) {
        log.error('[Relay] failed to answer challenge:', err instanceof Error ? err.message : err);
        this.ws?.close();
      }
      return;
    }

    if (msg.type === 'agent:ready') {
      this.connecting = false;
      this.connected = true;
      this.reconnectAttempts = 0;
      if (msg.machineId) setPreference(PREF.machineId, msg.machineId);
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

  /** Full shutdown for app quit. */
  stop(): void {
    this.stopKeepAwake();
    this.teardown();
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }
}
