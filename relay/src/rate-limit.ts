/**
 * Fixed-window rate limiting, plus the proxy-aware client-IP resolution it
 * depends on.
 *
 * The relay's abuse-sensitive routes are the ones that accept a secret: `/link`
 * mints link codes for anyone holding a keypair, and `/link/claim` is where a
 * code is guessed at. Both were previously unbounded.
 */

export interface RateLimiter {
  /**
   * Record a hit against `key` and report whether it is allowed. Returns the
   * seconds until the window resets when it is not, for `Retry-After`.
   */
  check(key: string, limit: number, windowMs: number): { allowed: true } | { allowed: false; retryAfter: number };
  /** Drop expired windows. Cheap; call from the periodic reaper. */
  sweep(): void;
}

interface Window {
  count: number;
  resetAt: number;
}

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, Window>();

  return {
    check(key, limit, windowMs) {
      const ts = now();
      const existing = windows.get(key);
      if (!existing || existing.resetAt <= ts) {
        windows.set(key, { count: 1, resetAt: ts + windowMs });
        return { allowed: true };
      }
      if (existing.count >= limit) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((existing.resetAt - ts) / 1000)) };
      }
      existing.count += 1;
      return { allowed: true };
    },

    sweep() {
      const ts = now();
      for (const [key, window] of windows) {
        if (window.resetAt <= ts) windows.delete(key);
      }
    },
  };
}

/**
 * The client address to bucket a request under.
 *
 * When `trustProxy` is off, the socket peer is the only trustworthy source.
 * When it is on we take the **rightmost** `X-Forwarded-For` entry, not the
 * leftmost: each proxy appends the peer it saw, so the last entry is the one
 * our own trusted proxy wrote. The leftmost is attacker-controlled — a client
 * that sends its own `X-Forwarded-For` gets it preserved ahead of the real
 * address, which would let one caller mint unlimited buckets and evade every
 * limit. This assumes exactly one trusted hop in front of the relay, which is
 * the documented deployment (Caddy → 127.0.0.1:47393).
 *
 * Returns null when nothing usable is available, and callers should fail open
 * rather than lump every anonymous request into a single bucket.
 */
export function clientIp(req: Request, peerIp: string | null, trustProxy: boolean): string | null {
  if (trustProxy) {
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) {
      const hops = forwarded
        .split(',')
        .map((hop) => hop.trim())
        .filter((hop) => hop.length > 0);
      const rightmost = hops[hops.length - 1];
      if (rightmost) return rightmost;
    }
  }
  return peerIp;
}
