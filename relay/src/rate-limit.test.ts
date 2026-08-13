import { describe, expect, test } from 'bun:test';
import { clientIp, createRateLimiter } from './rate-limit';

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
