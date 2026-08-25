/**
 * Delivering a sealed push message to a push service.
 *
 * The body handed in here was encrypted by the desktop agent against the
 * subscription's own keys (RFC 8291 `aes128gcm`). The relay adds the envelope
 * — VAPID identity, TTL, urgency — and POSTs it. It never constructs a
 * payload, and could not read one if it tried (design §10).
 */

import type { Vapid } from './vapid';

/**
 * Longest push-service endpoint the relay will store. Real ones run to a few
 * hundred characters; the cap exists so a row cannot be used as free storage.
 */
export const MAX_ENDPOINT_LENGTH = 1024;

/** How long a push service should hold an undelivered message. */
const PUSH_TTL_SECONDS = 4 * 60 * 60;

export interface PushDelivery {
  status: number | null;
  /** The subscription is dead and should be dropped: 404 or 410. */
  gone: boolean;
}

export interface PushDispatcher {
  deliver(endpoint: string, body: Uint8Array): Promise<PushDelivery>;
}

/**
 * Whether the relay is willing to POST to this URL.
 *
 * This is the SSRF boundary. The endpoint is chosen by whoever is holding a
 * browser — it arrives in a request body — and the relay then makes an
 * outbound request to it from inside its own network. Without this check,
 * "subscribe" is a general-purpose "make the relay POST arbitrary bytes at a
 * URL of my choosing" primitive, which reaches cloud metadata services and
 * anything else the relay's egress can see.
 *
 * So: HTTPS only, no credentials in the URL, no explicit port, and no
 * address-literal host. A hostname that RESOLVES to a private address still
 * gets through — defending against that needs resolution-time filtering in the
 * fetch layer, which Bun does not expose — so the network the relay runs on
 * should not treat outbound egress as trusted. Recorded rather than papered
 * over; see design §10.
 */
export function isAllowedPushEndpoint(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ENDPOINT_LENGTH) return false;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  // A port means "not a public push service"; every real one is on 443.
  if (url.port) return false;

  const host = url.hostname.toLowerCase();
  if (!host.includes('.')) return false; // bare `localhost`, container names
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;
  // Address literals, v4 and v6. `URL` gives IPv6 hosts in brackets.
  if (host.startsWith('[')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;

  return true;
}

/**
 * A dispatcher that really talks to push services. `fetchImpl` is injectable so
 * tests exercise the status handling without a network.
 */
export function createPushDispatcher(ctx: { vapid: Vapid; fetchImpl?: typeof fetch }): PushDispatcher {
  const doFetch = ctx.fetchImpl ?? fetch;

  return {
    async deliver(endpoint, body) {
      if (!isAllowedPushEndpoint(endpoint)) {
        // Refused rather than attempted: a stored row could predate this rule.
        // Reported as `gone` so the caller reaps it instead of retrying forever.
        return { status: null, gone: true };
      }
      const authorization = await ctx.vapid.authorization(endpoint);
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          authorization,
          // The body is already an RFC 8188 record: salt, record size, and the
          // agent's ephemeral public key are inside it, so no `Encryption` or
          // `Crypto-Key` header is involved.
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(PUSH_TTL_SECONDS),
          // A session waiting on a person is worth waking a dozing radio for.
          urgency: 'high',
        },
        body,
      });
      return { status: res.status, gone: res.status === 404 || res.status === 410 };
    },
  };
}
