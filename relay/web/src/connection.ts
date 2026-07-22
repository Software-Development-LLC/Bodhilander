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

export type ConnState = 'connecting' | 'handshaking' | 'ready' | 'offline' | 'closed' | 'error';
export interface Inner {
  type: string;
  [k: string]: unknown;
}

function wsUrl(path: string): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}

export class RelayConnection {
  private ws: WebSocket | null = null;
  private key: CryptoKey | null = null;
  private clientKeys: ClientKeys | null = null;
  private sendCounter = 0;
  private recvCounter = -1;

  onState: (s: ConnState, detail?: string) => void = () => {};
  onMessage: (m: Inner) => void = () => {};
  onFingerprint: (fp: string, verified: boolean) => void = () => {};

  constructor(
    private readonly machineId: string,
    /** The machine's Ed25519 pubkey (base64) as reported by /api/machines. */
    private readonly machineEd25519Pub: string,
  ) {}

  connect(): void {
    this.onState('connecting');
    const ws = new WebSocket(wsUrl('/ws/client'));
    this.ws = ws;
    ws.onopen = async () => {
      this.clientKeys = await generateClientKeys();
      this.send({ type: 'client:open', machineId: this.machineId, payload: { clientX25519Pub: this.clientKeys.pubB64 } });
      this.onState('handshaking');
    };
    ws.onmessage = (e) => void this.handle(JSON.parse(String(e.data)));
    ws.onclose = () => this.onState('closed');
    ws.onerror = () => this.onState('error');
  }

  private async handle(msg: Inner): Promise<void> {
    if (msg.type === 'agent:offline') return this.onState('offline');
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

    // Sealed frame.
    const frame = payload as unknown as SealedFrame;
    if (!this.key || typeof frame?.n !== 'number' || frame.n <= this.recvCounter) return;
    try {
      const inner = await openJson<Inner>(this.key, frame);
      this.recvCounter = frame.n;
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
    if (ws) {
      // Detach handlers first so this deliberate close doesn't surface as a
      // 'closed' state event (which the caller uses to schedule a reconnect).
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
  }
}
