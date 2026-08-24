/**
 * Manages the /ws/client connection: opens the channel, runs the E2E handshake
 * (verifying the agent's identity against the machine's known pubkey), then
 * seals/opens terminal + control frames. The relay only ever sees ciphertext.
 */

import {
  generateClientKeys,
  deriveSessionKey,
  verifyHandshakeProof,
  fingerprint,
  sealJson,
  openJson,
  type ClientKeys,
  type SealedFrame,
} from './crypto';

export type ConnState = 'connecting' | 'handshaking' | 'ready' | 'offline' | 'closed' | 'error' | 'denied';

/**
 * Why access ended. Distinct values because the copy differs and guessing
 * tells people false stories — "Will revoked your access" when Will merely
 * closed a terminal is socially loaded and untrue.
 */
/**
 * The reasons that actually END access. Anything else on a `denied` frame is a
 * refusal of one command, which must not be presented as losing access.
 *
 * The union is derived from this array rather than written twice, so the two
 * cannot drift — a reason added to one and not the other is the shape of the
 * bug this whole file is fixing.
 */
export const ENDING_REASONS = ['not_authorized', 'revoked', 'expired', 'session_ended', 'machine_unlinked'] as const;

export type DeniedReason = (typeof ENDING_REASONS)[number];

export function isEndingReason(reason: string): reason is DeniedReason {
  return (ENDING_REASONS as readonly string[]).includes(reason);
}

/**
 * The detail reported for a close-derived ending. Close reasons select
 * termination, never attribution: a person-attributed story ("they stopped
 * sharing") is reserved for reasons that arrive SEALED from the machine.
 */
export const CONNECTION_ENDED = 'connection_ended';
export interface Inner {
  type: string;
  [k: string]: unknown;
}

function wsUrl(path: string): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}

/**
 * Browser keepalive interval. Script can't send WebSocket control frames, so a
 * viewer that is only reading produces no upstream traffic at all and looks
 * idle to the relay and to anything between. Matches the agent's 30s ping.
 */
const PING_INTERVAL_MS = 30_000;

export class RelayConnection {
  private ws: WebSocket | null = null;
  private key: CryptoKey | null = null;
  private clientKeys: ClientKeys | null = null;
  private sendCounter = 0;
  private recvCounter = -1;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  onState: (s: ConnState, detail?: string) => void = () => {};
  onMessage: (m: Inner) => void = () => {};
  onFingerprint: (fp: string, verified: boolean) => void = () => {};
  /** One command was refused. Not an ended session — see `handle`. */
  onCommandDenied: (command: string) => void = () => {};

  constructor(
    private readonly machineId: string,
    /** The machine's Ed25519 pubkey (base64) as reported by /api/machines. */
    private readonly machineEd25519Pub: string,
    /**
     * A grant certificate, for a guest. Opaque here — the relay cannot read it
     * and neither can we; the agent verifies its own signature and decides
     * what it permits. Absent for the machine's owner.
     */
    private readonly certificate: string | null = null,
  ) {}

  connect(): void {
    this.onState('connecting');
    const ws = new WebSocket(wsUrl('/ws/client'));
    this.ws = ws;
    ws.onopen = async () => {
      // Armed here rather than in connect(): send() no-ops on a socket that
      // isn't OPEN, so an early tick was harmless, but there is no reason for
      // the timer to exist during a window where it can do nothing.
      this.startPing();
      this.clientKeys = await generateClientKeys();
      this.send({
        type: 'client:open',
        machineId: this.machineId,
        payload: {
          clientX25519Pub: this.clientKeys.pubB64,
          ...(this.certificate ? { certificate: this.certificate } : {}),
        },
      });
      this.onState('handshaking');
    };
    ws.onmessage = (e) => void this.handle(JSON.parse(String(e.data)));
    ws.onclose = (e) => {
      this.stopPing();
      // A 4403 with a known ending reason is terminal — reconnecting would
      // loop forever against a dead grant. The reason itself is not forwarded:
      // it came unsealed, so it may end the session but never tell its story.
      if (e.code === 4403 && isEndingReason(e.reason)) return this.onState('denied', CONNECTION_ENDED);
      this.onState('closed');
    };
    ws.onerror = () => this.onState('error');
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer === null) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private async handle(msg: Inner): Promise<void> {
    if (msg.type === 'agent:offline') return this.onState('offline');
    // The relay refuses to route a guest to an agent that does not enforce
    // grants — an older desktop build would ignore the certificate entirely.
    if (msg.type === 'share:unsupported') {
      return this.onState('error', 'That machine is running an older version that cannot share sessions safely.');
    }
    if (msg.type === 'channel:open') return; // relay ack
    if (msg.type !== 'from-agent') return;

    const payload = msg.payload as { type?: string; [k: string]: unknown };

    // Unsealed handshake reply.
    if (payload?.type === 'handshake') {
      const edPub = String(payload.ed25519Pub);
      const xPub = String(payload.agentX25519Pub);
      const sig = String(payload.signature);
      const sigOk = await verifyHandshakeProof(edPub, xPub, this.clientKeys!.pubB64, sig);
      const identityOk = edPub === this.machineEd25519Pub; // pin to the machine we asked for
      const fp = await fingerprint(edPub);
      this.onFingerprint(fp, sigOk && identityOk);
      if (!sigOk || !identityOk) {
        this.onState('error', 'This machine failed identity verification. The connection may be tampered with.');
        this.ws?.close();
        return;
      }
      this.key = await deriveSessionKey(this.clientKeys!.priv, xPub);
      this.onState('ready');
      return;
    }

    // An unsealed refusal, before any key exists. Only trusted to mean "you
    // did not get in" — never to explain why, since nothing has authenticated
    // it at this point.
    if (payload?.type === 'denied' && !this.key) {
      return this.onState('denied', 'not_authorized');
    }

    // Sealed frame.
    const frame = payload as unknown as SealedFrame;
    if (!this.key || typeof frame?.n !== 'number' || frame.n <= this.recvCounter) return;
    try {
      const inner = await openJson<Inner>(this.key, frame);
      this.recvCounter = frame.n;
      // A SEALED refusal is trustworthy: only the machine could have written
      // it, so its reason can safely drive what the guest is told.
      //
      // But ONLY an access-ended reason ends the session. A refused single
      // command is not an ended session, and treating every `denied` as
      // terminal told people the owner had revoked them when they had merely
      // sent one command their role does not allow. The reason is checked
      // against the known ending set rather than trusted blindly, which also
      // covers agents still sending the old shared frame type.
      if (inner.type === 'command:denied') {
        this.onCommandDenied(typeof inner.command === 'string' ? inner.command : '');
        return;
      }
      if (inner.type === 'denied') {
        // A `denied` with NO reason ends the session. Failing the other way
        // would swallow a genuine access-ended notice from any sender that
        // omits the field — silence is the worse error here, because the
        // guest would sit watching a channel that is already closed.
        // A reason that is present but not an ending one is a command
        // refusal, which is the legacy frame this fix exists for.
        const reason = typeof inner.reason === 'string' ? inner.reason : null;
        if (reason === null || isEndingReason(reason)) {
          this.onState('denied', reason ?? 'revoked');
        } else {
          this.onCommandDenied(typeof inner.command === 'string' ? inner.command : '');
        }
        return;
      }
      this.onMessage(inner);
    } catch {
      /* drop unauthenticatable frame */
    }
  }

  /** Seal and send a command to the agent (terminal:*, sessions:list, etc.). */
  async command(inner: Inner): Promise<void> {
    if (!this.key) return;
    const frame = await sealJson(this.key, this.sendCounter++, inner);
    this.send({ type: 'to-agent', payload: frame });
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.key = null;
    this.stopPing();
    if (ws) {
      // Detach handlers first so this deliberate close doesn't surface as a
      // 'closed' state event (which the caller uses to schedule a reconnect).
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
  }
}
