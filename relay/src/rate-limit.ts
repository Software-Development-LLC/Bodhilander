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
  /** Windows currently tracked. Bounded by `MAX_WINDOWS`. */
  size(): number;
}

interface Window {
  count: number;
  /** The limit this window was last checked against, so eviction can tell a
   *  throttling window from an idle one without the caller's help. */
  limit: number;
  resetAt: number;
}

/**
 * Hard ceiling on tracked windows.
 *
 * Without one the map grows once per distinct key until the next `sweep()`,
 * ten minutes away. The keys include the client address, and an attacker with
 * an IPv6 /64 has effectively unlimited distinct addresses, so that is a
 * memory-exhaustion path on a public route.
 */
export const MAX_WINDOWS = 50_000;

/** Windows dropped per eviction pass, so this is not an O(n) scan per request. */
const EVICT_BATCH = Math.ceil(MAX_WINDOWS / 10);

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, Window>();

  /**
   * Try to get below `MAX_WINDOWS`. Returns whether there is now room.
   *
   * Note what this deliberately is **not**: an LRU. Evicting the oldest entry
   * would bound memory by handing an attacker a rate-limit reset — flood
   * distinct keys until the window that is throttling *you* falls out, then
   * start over with a clean bucket. So eviction is count-aware: a window that
   * has not reached its limit is free to drop, because its holder was going to
   * be allowed through anyway, and a window that is actively throttling
   * someone is never dropped to make room.
   */
  function makeRoom(ts: number): boolean {
    for (const [key, window] of windows) {
      if (window.resetAt <= ts) windows.delete(key);
    }
    if (windows.size < MAX_WINDOWS) return true;

    let evicted = 0;
    for (const [key, window] of windows) {
      if (window.count >= window.limit) continue; // throttling someone — keep
      windows.delete(key);
      if (++evicted >= EVICT_BATCH) break;
    }
    return windows.size < MAX_WINDOWS;
  }

  return {
    check(key, limit, windowMs) {
      const ts = now();
      const existing = windows.get(key);

      if (existing && existing.resetAt > ts) {
        existing.limit = limit;
        if (existing.count >= limit) {
          return { allowed: false, retryAfter: Math.max(1, Math.ceil((existing.resetAt - ts) / 1000)) };
        }
        existing.count += 1;
        return { allowed: true };
      }

      // A fresh key needs a slot; replacing an expired window does not.
      if (!existing && windows.size >= MAX_WINDOWS && !makeRoom(ts)) {
        // Every tracked window is currently throttling someone, which takes a
        // distributed flood to reach. Refusing is the right answer here:
        // forgetting a window instead would reset a limit that is doing its
        // job, and this clears itself at the next window boundary.
        return { allowed: false, retryAfter: Math.max(1, Math.ceil(windowMs / 1000)) };
      }

      windows.set(key, { count: 1, limit, resetAt: ts + windowMs });
      return { allowed: true };
    },

    sweep() {
      const ts = now();
      for (const [key, window] of windows) {
        if (window.resetAt <= ts) windows.delete(key);
      }
    },

    size() {
      return windows.size;
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
