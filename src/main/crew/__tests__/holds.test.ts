import { describe, expect, test } from 'bun:test';
import { Holds, capDay, capTokens, hireTimeZone, machineTimeZone, overCrewCap, readWindow, type HoldInputs } from '../holds';

const NOW = 1_700_000_000_000;
const win = (pct: number, resetsAt: number | null = NOW + 1000) => ({ pct, resetsAt, observedAt: NOW });
const base = (over: Partial<HoldInputs> = {}): HoldInputs => ({
  accountId: 'a1',
  signedIn: true,
  usage: null,
  cap: { fiveHourPct: 90, sevenDayPct: 90 },
  hireCap: { dailyTokens: null, usedToday: 0 },
  now: NOW,
  ...over,
});

describe('holds', () => {
  test('causes are checked in order', () => {
    const h = new Holds();
    h.recordRateLimit('a1', NOW + 10);
    const usage = { fiveHour: win(95), sevenDay: null } as never;
    expect(h.evaluate(base({ accountId: null, signedIn: false }))).toBe('missing');
    expect(h.evaluate(base({ signedIn: false }))).toBe('signed-out');
    expect(h.evaluate(base({ usage }))).toBe('rate-limited');
    expect(h.evaluate(base({ usage, now: NOW + 10 }))).toBe('crew-cap');
    expect(h.evaluate(base({ hireCap: { dailyTokens: 100, usedToday: 100 }, now: NOW + 10 }))).toBe('hire-cap');
    expect(h.evaluate(base({ hireCap: { dailyTokens: 100, usedToday: 99 }, now: NOW + 10 }))).toBeNull();
  });

  test('the per-hire cap is off by default', () => {
    expect(new Holds().evaluate(base({ hireCap: { dailyTokens: null, usedToday: 10 ** 9 } }))).toBeNull();
  });

  test('a rate limit lifts at its reset time, and a later hit replaces it', () => {
    const h = new Holds();
    h.recordQuotaLimit('a1', { resetAt: new Date(NOW + 5) } as never);
    expect(h.rateLimitedUntil('a1', NOW)).toBe(NOW + 5);
    h.recordRateLimit('a1', NOW + 50);
    expect(h.rateLimitedUntil('a1', NOW + 5)).toBe(NOW + 50);
    expect(h.rateLimitedUntil('a1', NOW + 50)).toBeNull();
  });

  test('the account cap reads reported windows only', () => {
    const cap = { fiveHourPct: 90, sevenDayPct: 80 };
    expect(overCrewCap(null, cap, NOW)).toBe(false);
    expect(overCrewCap({ fiveHour: win(89), sevenDay: win(79) } as never, cap, NOW)).toBe(false);
    expect(overCrewCap({ fiveHour: win(90), sevenDay: null } as never, cap, NOW)).toBe(true);
    expect(overCrewCap({ fiveHour: null, sevenDay: win(80) } as never, cap, NOW)).toBe(true);
    expect(overCrewCap({ fiveHour: win(99, NOW), sevenDay: null } as never, cap, NOW)).toBe(false);
    expect(readWindow(win(99, NOW - 1), NOW)).toBe('not reported');
    expect(readWindow(win(42, null), NOW)).toEqual({ pct: 42 });
  });

  test('one notice per cause, and a release lets the next hold notify', () => {
    const h = new Holds();
    expect(h.shouldNotify('h', 'crew-cap')).toBe(true);
    expect(h.shouldNotify('h', 'crew-cap')).toBe(false);
    expect(h.shouldNotify('h', 'signed-out')).toBe(true);
    expect(h.shouldNotify('h', null)).toBe(false);
    expect(h.shouldNotify('h', 'signed-out')).toBe(true);
  });

  test('cap tokens skip cache reads, and the day follows the owner timezone', () => {
    expect(capTokens({ input_tokens: 1, cache_creation_input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 1000 } as never)).toBe(6);
    const t = Date.UTC(2026, 0, 2, 3, 0);
    expect(capDay(t, 'UTC')).toBe('2026-01-02');
    expect(capDay(t, 'America/Chicago')).toBe('2026-01-01');
    expect(capDay(t, 'Not/AZone')).toBe('2026-01-02');
  });
});

describe("the owner's day", () => {
  test("is this machine's own IANA zone, or null when it has none to give", () => {
    expect(machineTimeZone(() => 'America/Chicago')).toBe('America/Chicago');
    expect(machineTimeZone(() => undefined)).toBeNull();
    expect(machineTimeZone(() => 'Not/AZone')).toBeNull();
    expect(machineTimeZone(() => {
      throw new Error('no Intl');
    })).toBeNull();
  });

  test("a hire's zone is its owner's when valid, else this machine's, else UTC", () => {
    const paris = () => 'Europe/Paris';
    expect(hireTimeZone({ ownerTimezone: 'America/Chicago' }, paris)).toBe('America/Chicago');
    expect(hireTimeZone({ ownerTimezone: 'Not/AZone' }, paris)).toBe('Europe/Paris');
    expect(hireTimeZone({ ownerTimezone: null }, paris)).toBe('Europe/Paris');
    expect(hireTimeZone(null, paris)).toBe('Europe/Paris');
    expect(hireTimeZone({ ownerTimezone: null }, () => null)).toBeNull();
  });
});
