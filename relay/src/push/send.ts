/**
 * Delivering a sealed push message. The body was encrypted by the agent against
 * the subscription's own keys; the relay adds the envelope and POSTs it. It
 * never constructs a payload and could not read one (design §10).
 */

import type { Vapid } from './vapid';

/**
 * Longest push-service endpoint the relay will store. Real ones run to a few
 * hundred characters; the cap exists so a row cannot be used as free storage.
 */
export const MAX_ENDPOINT_LENGTH = 1024;

/** How long a push service should hold an undelivered message. */
const PUSH_TTL_SECONDS = 4 * 60 * 60;

/**
 * How long one POST may take. Without it a deliberately slow endpoint pins the
 * socket and stalls the rest of its batch — including the reap re-sync that
 * runs after it.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

export interface PushDelivery {
  status: number | null;
  /** The subscription is dead and should be dropped: 404 or 410. */
  gone: boolean;
  /** The endpoint answered with a redirect, which we refuse to follow. */
  redirected?: boolean;
}

export interface PushDispatcher {
  deliver(endpoint: string, body: Uint8Array): Promise<PushDelivery>;
}

/**
 * Whether the relay will POST to this URL — the SSRF boundary. The endpoint
 * arrives in a request body and the relay dials it from inside its own network,
 * so unchecked this is "make the relay POST bytes at a URL of my choosing".
 */

// HTTPS only, no credentials, no port, no address-literal host. A name that
// RESOLVES to a private address still gets through: that needs resolution-time
// filtering Bun does not expose, so outbound egress is not trusted — §10.
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

  // The trailing dot of a fully-qualified name is stripped BEFORE anything is
  // matched. `URL` preserves it, so `metadata.google.internal.` resolves to the
  // same host as the name the suffix list below refuses — and `localhost.` also
  // slips the bare-name check, because it now contains a dot.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.')) return false; // bare `localhost`, container names
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;
  // Address literals, v4 and v6. `URL` gives IPv6 hosts in brackets, and
  // normalises the shorthand forms (`2130706433`, `0x7f000001`, `127.1`) into
  // dotted quads before this regex sees them.
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
        // The allow-list above checks the URL we are GIVEN. Following a
        // redirect would make the relay dial a URL nothing checked, which
        // discards every property that list enforces in one hop.
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // A real push service never redirects. Treated as a failure and NOT as
      // `gone`: reaping here would turn the refusal into a probe that reports
      // back through the re-sync, which is the oracle this closes.
      if (res.status >= 300 && res.status < 400) return { status: res.status, gone: false, redirected: true };
      return { status: res.status, gone: res.status === 404 || res.status === 410 };
    },
  };
}
