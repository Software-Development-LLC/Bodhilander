/**
 * Per-web-client E2E terminal tunnel (M3, agent side).
 *
 * The relay hands us opaque frames from a web client; we complete an X25519
 * handshake (signed with our Ed25519 identity so the client can prove it's
 * really talking to this machine), then exchange AES-256-GCM-sealed terminal
 * frames. The relay only ever sees ciphertext.
 *
 * Terminal semantics mirror the existing LAN ws-server: `terminal:subscribe`
 * replays the scrollback then streams live `terminal:output` / `terminal:exit`;
 * `terminal:input` / `terminal:resize` drive the PTY. Frames are routed to the
 * relay via the `route(clientId, payload)` callback (which wraps them in a
 * `to-client` message).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import { ptyManager } from '../../pty-manager';
import { getAllSessions } from '../../repositories/sessions';
import { getAllGroups } from '../../repositories/groups';
import { createRemoteSession, createRemoteGroup } from './remote-sessions';
import { deriveSharedSecret, ensureIdentity, signWithIdentity } from './relay-identity';
import { deriveSessionKey, sealJson, openJson, buildHandshakeProof, type SealedFrame } from './e2e';
import { sanitizeSize } from './terminal-size';

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}


interface ClientSession {
  key: Buffer;
  sendCounter: number;
  recvCounter: number;
  /** Session ids this client is streaming. */
  subs: Set<string>;
  onData: (e: { id: string; data: string }) => void;
  onExit: (e: { id: string; exitCode: number }) => void;
  onResize: (e: { id: string; cols: number; rows: number }) => void;
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

export class SessionTunnel {
  private readonly sessions = new Map<string, ClientSession>();

  /** `route` sends an outbound payload to a client id via the relay. */
  constructor(private readonly route: (clientId: string, payload: unknown) => void) {}

  /** A web client opened a channel — complete the E2E handshake. */
  open(clientId: string, payload: unknown): void {
    try {
      const clientX25519Pub = (payload as { clientX25519Pub?: unknown })?.clientX25519Pub;
      if (typeof clientX25519Pub !== 'string') return;

      const shared = deriveSharedSecret(new Uint8Array(Buffer.from(clientX25519Pub, 'base64')));
      const key = deriveSessionKey(shared);
      const identity = ensureIdentity();
      const signature = signWithIdentity(buildHandshakeProof(clientX25519Pub, identity.x25519Pub)).toString('base64');

      const onData = (e: { id: string; data: string }) => {
        const s = this.sessions.get(clientId);
        if (s?.subs.has(e.id)) this.sealTo(clientId, { type: 'terminal:output', sessionId: e.id, data: e.data });
      };
      const onExit = (e: { id: string; exitCode: number }) => {
        const s = this.sessions.get(clientId);
        if (s?.subs.has(e.id)) this.sealTo(clientId, { type: 'terminal:exit', sessionId: e.id, exitCode: e.exitCode });
      };
      // Dynamic sizing: when the PTY is resized (by this or any other viewer),
      // tell subscribed clients the new size so they re-render at it.
      const onResize = (e: { id: string; cols: number; rows: number }) => {
        const s = this.sessions.get(clientId);
        if (s?.subs.has(e.id)) this.sealTo(clientId, { type: 'terminal:size', sessionId: e.id, cols: e.cols, rows: e.rows });
      };
      ptyManager.on('data', onData);
      ptyManager.on('exit', onExit);
      ptyManager.on('resize', onResize);
      this.sessions.set(clientId, { key, sendCounter: 0, recvCounter: -1, subs: new Set(), onData, onExit, onResize });

      // Unsealed handshake reply: client verifies `signature` against the
      // machine's known Ed25519 pubkey, then derives the same session key.
      this.route(clientId, {
        type: 'handshake',
        agentX25519Pub: identity.x25519Pub,
        ed25519Pub: identity.ed25519Pub,
        signature,
      });
      this.sendSessions(clientId);
      log.info('[Relay] client channel opened', { clientId });
    } catch (err) {
      log.error('[Relay] tunnel open failed:', err instanceof Error ? err.message : err);
    }
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
      log.warn('[Relay] dropped an unauthenticatable client frame');
      return;
    }
    s.recvCounter = frame.n;
    this.dispatch(clientId, s, inner);
  }

  /** Route one decrypted client command. Each case stays trivial; real work
   *  lives in a dedicated handler so this method's complexity stays low. */
  private dispatch(clientId: string, s: ClientSession, inner: ClientFrame): void {
    switch (inner.type) {
      case 'groups:list':
        this.sendGroups(clientId);
        break;
      case 'session:create':
        this.handleSessionCreate(clientId, inner);
        break;
      case 'terminal:subscribe':
        void this.handleSubscribe(clientId, s, inner);
        break;
      case 'terminal:unsubscribe':
        if (typeof inner.sessionId === 'string') s.subs.delete(inner.sessionId);
        break;
      case 'terminal:input':
        // The client is authenticated as the machine owner (E2E handshake), but
        // scope input to sessions it's actually subscribed to as defense-in-depth.
        if (typeof inner.sessionId === 'string' && typeof inner.data === 'string' && s.subs.has(inner.sessionId)) {
          ptyManager.write(inner.sessionId, inner.data);
        }
        break;
      case 'terminal:resize': {
        // Dynamic sizing: the active viewer drives the shared PTY size so a phone
        // can reflow Claude to fit. Now that this is live network-triggered input
        // into a native PTY resize, clamp/validate the size and scope it to a
        // subscribed session.
        const size = sanitizeSize(inner.cols, inner.rows);
        if (typeof inner.sessionId === 'string' && size && s.subs.has(inner.sessionId)) {
          ptyManager.resize(inner.sessionId, size.cols, size.rows);
        }
        break;
      }
      case 'sessions:list':
        this.sendSessions(clientId);
        break;
      case 'dirs:list':
        this.handleDirsList(clientId, inner);
        break;
      case 'group:create':
        this.handleGroupCreate(clientId, inner);
        break;
    }
  }

  private handleSessionCreate(clientId: string, inner: ClientFrame): void {
    if (typeof inner.groupId !== 'string' || typeof inner.name !== 'string') return;
    const provider = typeof inner.provider === 'string' ? inner.provider : 'claude';
    const isShell = provider === 'shell';
    try {
      createRemoteSession({
        groupId: inner.groupId,
        name: inner.name.trim() || 'session',
        provider: isShell ? 'claude' : provider,
        launchClaude: !isShell,
      });
      this.sendSessions(clientId); // refresh the client's list with the new session
    } catch (err) {
      this.sealTo(clientId, { type: 'error', message: err instanceof Error ? err.message : 'could not create session' });
    }
  }

  private async handleSubscribe(clientId: string, s: ClientSession, inner: ClientFrame): Promise<void> {
    if (typeof inner.sessionId !== 'string') return;
    const sessionId = inner.sessionId;
    s.subs.add(sessionId);
    // Tell the viewer the PTY's current size so it renders TUIs correctly.
    const size = ptyManager.getSize(sessionId);
    this.sealTo(clientId, { type: 'terminal:size', sessionId, cols: size.cols, rows: size.rows });
    // Replay history as RENDERED TEXT (reflow-safe) so a phone can resize the
    // shared terminal without the scrollback garbling. Then live output streams.
    const history = await ptyManager.getSerializedBuffer(sessionId);
    if (s.subs.has(sessionId)) {
      this.sealTo(clientId, { type: 'terminal:output', sessionId, data: history });
    }
  }

  private handleDirsList(clientId: string, inner: ClientFrame): void {
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

  private handleGroupCreate(clientId: string, inner: ClientFrame): void {
    if (typeof inner.name !== 'string' || !inner.name.trim()) return;
    try {
      createRemoteGroup({
        name: inner.name,
        parentId: typeof inner.parentId === 'string' ? inner.parentId : null,
        workingDir: typeof inner.workingDir === 'string' ? expandHome(inner.workingDir) : '',
        color: typeof inner.color === 'string' ? inner.color : '#35c2d1',
      });
      this.sendGroups(clientId);
    } catch (err) {
      this.sealTo(clientId, { type: 'error', message: err instanceof Error ? err.message : 'could not create group' });
    }
  }

  /** A web client disconnected — drop its state and PTY listeners. */
  closeClient(clientId: string): void {
    const s = this.sessions.get(clientId);
    if (!s) return;
    ptyManager.off('data', s.onData);
    ptyManager.off('exit', s.onExit);
    ptyManager.off('resize', s.onResize);
    this.sessions.delete(clientId);
  }

  /** Tear down every client (agent WebSocket dropped). */
  closeAll(): void {
    for (const clientId of [...this.sessions.keys()]) this.closeClient(clientId);
  }

  private sendSessions(clientId: string): void {
    const list = getAllSessions()
      .filter((session) => ptyManager.getSession(session.id))
      .map((session) => ({
        id: session.id,
        name: session.name,
        state: session.state,
        groupId: session.groupId,
        workingDir: session.workingDir,
        provider: session.provider,
        shellType: session.shellType,
      }));
    this.sealTo(clientId, { type: 'sessions', sessions: list });
  }

  private sendGroups(clientId: string): void {
    const groups = getAllGroups().map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color,
      workingDir: g.workingDir,
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
