import { describe, expect, test } from 'bun:test';
import { clientIp, createRateLimiter, MAX_WINDOWS } from './rate-limit';

/** A limiter driven by a clock the test controls. */
function fixedClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const req = (headers: Record<string, string> = {}) => new Request('https://relay.example.com/link', { headers });

describe('createRateLimiter', () => {
  test('allows up to the limit, then refuses', () => {
    const limiter = createRateLimiter(fixedClock().now);

    for (let i = 0; i < 3; i++) {
      expect(limiter.check('a', 3, 60_000).allowed).toBe(true);
    }
    expect(limiter.check('a', 3, 60_000).allowed).toBe(false);
  });

  test('reports the seconds remaining in the window', () => {
    const clock = fixedClock();
    const limiter = createRateLimiter(clock.now);

    limiter.check('a', 1, 60_000);
    clock.advance(20_000);
    const result = limiter.check('a', 1, 60_000);

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.retryAfter).toBe(40);
  });

  test('keys are independent', () => {
    const limiter = createRateLimiter(fixedClock().now);

    expect(limiter.check('a', 1, 60_000).allowed).toBe(true);
    expect(limiter.check('a', 1, 60_000).allowed).toBe(false);
    expect(limiter.check('b', 1, 60_000).allowed).toBe(true);
  });

  test('the window reopens once it elapses', () => {
    const clock = fixedClock();
    const limiter = createRateLimiter(clock.now);

    limiter.check('a', 1, 60_000);
    expect(limiter.check('a', 1, 60_000).allowed).toBe(false);

    clock.advance(60_001);
    expect(limiter.check('a', 1, 60_000).allowed).toBe(true);
  });

  test('sweep drops elapsed windows but keeps live ones', () => {
    const clock = fixedClock();
    const limiter = createRateLimiter(clock.now);

    limiter.check('old', 1, 10_000);
    clock.advance(20_000);
    limiter.check('fresh', 1, 60_000);
    limiter.sweep();

    // 'old' was forgotten, so its budget is available again...
    expect(limiter.check('old', 1, 10_000).allowed).toBe(true);
    // ...while 'fresh' is still being counted.
    expect(limiter.check('fresh', 1, 60_000).allowed).toBe(false);
  });
});

describe('createRateLimiter memory bound', () => {
  /** Enough past the ceiling to force at least one eviction pass. */
  const EXTRA = 1_000;

  /** Fill the limiter with distinct single-hit keys, as a flood would. */
  function flood(limiter: ReturnType<typeof createRateLimiter>, count: number, prefix = 'flood') {
    for (let i = 0; i < count; i++) limiter.check(`${prefix}:${i}`, 5, 60_000);
  }

  test('stays bounded no matter how many distinct keys arrive', () => {
    const limiter = createRateLimiter(fixedClock().now);

    flood(limiter, MAX_WINDOWS + EXTRA);

    expect(limiter.size()).toBeLessThanOrEqual(MAX_WINDOWS);
  });

  test('a throttled window survives a flood of fresh keys', () => {
    // The property that makes this not an LRU. If eviction dropped the oldest
    // entry, an attacker could flush the window that is throttling them and
    // start over with a clean bucket -- trading a memory bound for a
    // rate-limit bypass.
    const limiter = createRateLimiter(fixedClock().now);

    for (let i = 0; i < 3; i++) limiter.check('victim', 3, 60_000);
    expect(limiter.check('victim', 3, 60_000).allowed).toBe(false);

    flood(limiter, MAX_WINDOWS + EXTRA);

    expect(limiter.check('victim', 3, 60_000).allowed).toBe(false);
  });

  test('evicts idle windows rather than throttling ones', () => {
    // An under-limit window is free to drop: its holder was going to be let
    // through anyway, so forgetting it costs nothing.
    const limiter = createRateLimiter(fixedClock().now);

    limiter.check('idle', 5, 60_000); // 1 of 5 -- not throttling anyone
    flood(limiter, MAX_WINDOWS + EXTRA);

    expect(limiter.size()).toBeLessThanOrEqual(MAX_WINDOWS);
    expect(limiter.check('idle', 5, 60_000).allowed).toBe(true);
  });

  test('expired windows are reclaimed before anything live is evicted', () => {
    const clock = fixedClock();
    const limiter = createRateLimiter(clock.now);

    flood(limiter, MAX_WINDOWS, 'stale');
    clock.advance(60_001); // every stale window has now elapsed

    // A single fresh key should reclaim the whole expired generation.
    limiter.check('fresh', 5, 60_000);

    expect(limiter.size()).toBeLessThan(MAX_WINDOWS);
  });

  test('refuses rather than forgetting a limit when every window is throttling', () => {
    // Reaching this needs a distributed flood that actually throttles
    // MAX_WINDOWS distinct buckets. Refusing is the safe answer -- evicting
    // instead would reset a limit that is doing its job -- and it clears at
    // the next window boundary.
    const clock = fixedClock();
    const limiter = createRateLimiter(clock.now);

    for (let i = 0; i < MAX_WINDOWS; i++) {
      const key = `saturated:${i}`;
      limiter.check(key, 1, 60_000); // one hit against a limit of one
    }

    const result = limiter.check('newcomer', 5, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.retryAfter).toBe(60);

    // Self-healing: once the windows elapse, the newcomer gets through.
    clock.advance(60_001);
    expect(limiter.check('newcomer', 5, 60_000).allowed).toBe(true);
  });
});

describe('clientIp', () => {
  test('uses the socket peer when the proxy is not trusted', () => {
    expect(clientIp(req({ 'x-forwarded-for': '9.9.9.9' }), '10.0.0.1', false)).toBe('10.0.0.1');
  });

  test('uses X-Forwarded-For when the proxy is trusted', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7' }), '127.0.0.1', true)).toBe('203.0.113.7');
  });

  test('takes the RIGHTMOST hop, so a client-supplied header cannot forge a bucket', () => {
    // Our proxy appends the address it actually saw, so the last entry is the
    // only trustworthy one. Honouring the leftmost would let one caller mint
    // unlimited buckets and evade every limit.
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }), '127.0.0.1', true)).toBe('203.0.113.7');
  });

  test('tolerates whitespace and empty entries', () => {
    expect(clientIp(req({ 'x-forwarded-for': ' 1.2.3.4 ,  203.0.113.7 , ' }), '127.0.0.1', true)).toBe('203.0.113.7');
  });

  test('falls back to the peer when the trusted proxy sent no header', () => {
    expect(clientIp(req(), '127.0.0.1', true)).toBe('127.0.0.1');
  });

  test('returns null when nothing is available, so callers can fail open', () => {
    expect(clientIp(req(), null, true)).toBeNull();
    expect(clientIp(req({ 'x-forwarded-for': '' }), null, true)).toBeNull();
  });
});
