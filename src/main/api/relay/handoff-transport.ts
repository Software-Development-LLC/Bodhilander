/**
 * The handoff slot, as four signed HTTP calls. Kept out of the relay client
 * because no socket is involved, which lets the whole thing be driven against
 * the relay's own router — the only place the two wire formats meet.
 */

import crypto from 'crypto';
import type { HandoffOffer } from '../../../shared/types';
import type { HandoffTransport } from '../../transfer/handoff';

// --- wire format (keep in sync with relay/src/protocol.ts) ---
const PUT = 'handoff-put:v1';
const META = 'handoff-meta:v1';
const GET = 'handoff-get:v1';
const DELETE = 'handoff-delete:v1';
const SIGNATURE_HEADER = 'x-bodhi-signature';
const ISSUED_AT_HEADER = 'x-bodhi-issued-at';
const DIGEST_HEADER = 'x-bodhi-content-sha256';
const ID_HEADER = 'x-bodhi-handoff-id';

export interface HandoffEndpoint {
  /** Relay origin, e.g. `https://relay.example.com`. */
  origin: string;
  /** This machine's id on that relay; the slot is its user's. */
  machineId: string;
  sign(message: Uint8Array): Buffer;
  /** Injectable so the transport can be driven against a router in-process. */
  fetchImpl?: typeof fetch;
}

/**
 * A refusal the window can show. The body is read for the relay's own reason,
 * and a status is spelled out when there is none — a request killed at the
 * socket for its size arrives with nothing in it at all.
 */
async function refusal(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => '');
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: string; maxBytes?: number };
    if (parsed?.error) {
      detail = parsed.error.replace(/_/g, ' ');
      if (typeof parsed.maxBytes === 'number') detail += ` — this relay carries up to ${parsed.maxBytes} bytes`;
    }
  } catch {
    // Not JSON; the raw text, or nothing, is the best that can be said.
  }
  if (!detail && res.status === 413) detail = 'the relay refused it as too large';
  const because = detail ? `: ${detail}` : '';
  return new Error(`Could not ${what} (${res.status})${because}`);
}

export function createHandoffTransport(endpoint: HandoffEndpoint): HandoffTransport {
  const origin = endpoint.origin.replace(/\/+$/, '');
  const { machineId } = endpoint;
  const call = endpoint.fetchImpl ?? fetch;
  const slot = `${origin}/api/machines/${machineId}/handoff`;

  /** Sign one verb. The joined lines must match the relay's builders exactly. */
  function auth(parts: string[], extra: Record<string, string> = {}): Record<string, string> {
    const issuedAt = Date.now();
    const message = new TextEncoder().encode([...parts, String(issuedAt)].join('\n'));
    return {
      [ISSUED_AT_HEADER]: String(issuedAt),
      [SIGNATURE_HEADER]: endpoint.sign(message).toString('base64'),
      ...extra,
    };
  }

  return {
    async upload(sealed) {
      const digest = crypto.createHash('sha256').update(sealed).digest('hex');
      const res = await call(slot, {
        method: 'PUT',
        headers: auth([PUT, machineId, digest], {
          'content-type': 'application/octet-stream',
          [DIGEST_HEADER]: digest,
        }),
        body: new Uint8Array(sealed),
      });
      if (!res.ok) throw await refusal(res, 'store the handoff');
      return ((await res.json()) as { handoff: HandoffOffer }).handoff;
    },

    async peek() {
      const res = await call(slot, { headers: auth([META, machineId]) });
      if (!res.ok) throw await refusal(res, 'read the handoff');
      const { handoff } = (await res.json()) as { handoff: HandoffOffer | null };
      // A machine is never offered the bundle it prepared itself.
      return handoff?.sourceMachineId === machineId ? null : handoff;
    },

    async download() {
      const res = await call(`${slot}/bundle`, { headers: auth([GET, machineId]) });
      if (!res.ok) throw await refusal(res, 'download the handoff');
      const id = res.headers.get(ID_HEADER);
      if (!id) throw new Error('The relay returned a handoff with no id.');
      return { id, sealed: Buffer.from(await res.arrayBuffer()) };
    },

    async acknowledge(handoffId) {
      const res = await call(`${slot}?id=${encodeURIComponent(handoffId)}`, {
        method: 'DELETE',
        headers: auth([DELETE, machineId, handoffId]),
      });
      // Already gone is the state the caller was asking for.
      if (!res.ok && res.status !== 404) throw await refusal(res, 'clear the handoff');
    },
  };
}
