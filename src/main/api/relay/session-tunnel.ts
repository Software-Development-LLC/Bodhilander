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

import log from 'electron-log';
import { ptyManager } from '../../pty-manager';
import { getAllSessions } from '../../repositories/sessions';
import { getAllGroups } from '../../repositories/groups';
import { createRemoteSession } from './remote-sessions';
import { deriveSharedSecret, ensureIdentity, signWithIdentity } from './relay-identity';
import { deriveSessionKey, sealJson, openJson, buildHandshakeProof, type SealedFrame } from './e2e';

interface ClientSession {
  key: Buffer;
  sendCounter: number;
  recvCounter: number;
  /** Session ids this client is streaming. */
  subs: Set<string>;
  onData: (e: { id: string; data: string }) => void;
  onExit: (e: { id: string; exitCode: number }) => void;
}

export class SessionTunnel {
  private sessions = new Map<string, ClientSession>();

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
        if (s && s.subs.has(e.id)) this.sealTo(clientId, { type: 'terminal:output', sessionId: e.id, data: e.data });
      };
      const onExit = (e: { id: string; exitCode: number }) => {
        const s = this.sessions.get(clientId);
        if (s && s.subs.has(e.id)) this.sealTo(clientId, { type: 'terminal:exit', sessionId: e.id, exitCode: e.exitCode });
      };
      ptyManager.on('data', onData);
      ptyManager.on('exit', onExit);
      this.sessions.set(clientId, { key, sendCounter: 0, recvCounter: -1, subs: new Set(), onData, onExit });

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

    let inner: {
      type?: string;
      sessionId?: string;
      data?: string;
      cols?: number;
      rows?: number;
      groupId?: string;
      name?: string;
      provider?: string;
    };
    try {
      inner = openJson(s.key, frame);
    } catch {
      log.warn('[Relay] dropped an unauthenticatable client frame');
      return;
    }
    s.recvCounter = frame.n;

    switch (inner.type) {
      case 'groups:list':
        this.sendGroups(clientId);
        break;
      case 'session:create': {
        if (typeof inner.groupId !== 'string' || typeof inner.name !== 'string') break;
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
        break;
      }
      case 'terminal:subscribe':
        if (typeof inner.sessionId === 'string') {
          s.subs.add(inner.sessionId);
          // Replay scrollback so the browser shows history, then live output streams.
          this.sealTo(clientId, { type: 'terminal:output', sessionId: inner.sessionId, data: ptyManager.getBuffer(inner.sessionId) });
        }
        break;
      case 'terminal:unsubscribe':
        if (typeof inner.sessionId === 'string') s.subs.delete(inner.sessionId);
        break;
      case 'terminal:input':
        // The client is authenticated as the machine owner → full control.
        if (typeof inner.sessionId === 'string' && typeof inner.data === 'string') ptyManager.write(inner.sessionId, inner.data);
        break;
      case 'terminal:resize':
        if (typeof inner.sessionId === 'string') {
          ptyManager.resize(inner.sessionId, Number(inner.cols) || 80, Number(inner.rows) || 24);
        }
        break;
      case 'sessions:list':
        this.sendSessions(clientId);
        break;
    }
  }

  /** A web client disconnected — drop its state and PTY listeners. */
  closeClient(clientId: string): void {
    const s = this.sessions.get(clientId);
    if (!s) return;
    ptyManager.off('data', s.onData);
    ptyManager.off('exit', s.onExit);
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
