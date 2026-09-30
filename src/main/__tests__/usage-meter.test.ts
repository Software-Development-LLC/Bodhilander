/**
 * Parsing and judging usage. An undocumented shape must read as "no data",
 * never as 0%. Run with: bun test <this file>
 */
import { describe, expect, test } from 'bun:test';

import {
  describeCrossing,
  emptyUsage,
  mergeUsage,
  parseOAuthUsage,
  parseStatuslineSink,
  ThresholdNotices,
} from '../usage-meter';
import {
  formatDuration,
  isOverThreshold,
  parseUsageThreshold,
  usageLevel,
  USAGE_STALE_MS,
} from '../../shared/usage';
import { AccountUsage } from '../../shared/types';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const MIN = 60_000;

function usage(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    ...emptyUsage('work'),
    fiveHour: { pct: 40, resetsAt: NOW + 60 * MIN },
    sevenDay: { pct: 10, resetsAt: NOW + 3 * 24 * 60 * MIN },
    source: 'poll',
    observedAt: NOW,
    ...over,
  };
}

describe('parseOAuthUsage', () => {
  test('reads both windows, percent and ISO reset', () => {
    const obs = parseOAuthUsage({
      five_hour: { utilization: 92, resets_at: '2026-09-30T12:40:00.123Z' },
      seven_day: { utilization: 31.5, resets_at: '2026-10-03T08:00:00Z' },
      seven_day_opus: null,
    }, NOW);
    expect(obs).toEqual({
      fiveHour: { pct: 92, resetsAt: Date.parse('2026-09-30T12:40:00.123Z') },
      sevenDay: { pct: 31.5, resetsAt: Date.parse('2026-10-03T08:00:00Z') },
      source: 'poll',
      observedAt: NOW,
    });
  });

  test('a null window is absent, not zero', () => {
    const obs = parseOAuthUsage({ five_hour: null, seven_day: { utilization: 5, resets_at: null } }, NOW);
    expect(obs?.fiveHour).toBeNull();
    expect(obs?.sevenDay).toEqual({ pct: 5, resetsAt: null });
  });

  test.each([
    ['not an object', 'nope'],
    ['an array', []],
    ['missing seven_day', { five_hour: { utilization: 1, resets_at: null } }],
    ['both windows null', { five_hour: null, seven_day: null }],
    ['utilization as a string', { five_hour: { utilization: '40', resets_at: null }, seven_day: null }],
    ['negative utilization', { five_hour: { utilization: -1, resets_at: null }, seven_day: null }],
    ['an unparseable reset', { five_hour: { utilization: 1, resets_at: 'soon' }, seven_day: null }],
    ['a renamed field', { five_hour: { used: 40, resets_at: null }, seven_day: null }],
  ])('%s is no data', (_name, body) => {
    expect(parseOAuthUsage(body, NOW)).toBeNull();
  });
});

describe('parseStatuslineSink', () => {
  test('reads used_percentage and an epoch-seconds reset', () => {
    const obs = parseStatuslineSink({
      observedAt: NOW,
      rate_limits: { five_hour: { used_percentage: 12, resets_at: 1790000000 } },
    });
    expect(obs).toEqual({
      fiveHour: { pct: 12, resetsAt: 1790000000 * 1000 },
      sevenDay: null,
      source: 'statusline',
      observedAt: NOW,
    });
  });

  test('without its own timestamp it is not an observation', () => {
    expect(parseStatuslineSink({ rate_limits: { five_hour: { used_percentage: 12 } } })).toBeNull();
  });
});

describe('mergeUsage', () => {
  test('the newer observation wins, and a window it lacks is kept', () => {
    const merged = mergeUsage(usage({ unavailable: 'error' }), {
      fiveHour: { pct: 70, resetsAt: NOW + 30 * MIN },
      sevenDay: null,
      source: 'statusline',
      observedAt: NOW + MIN,
    });
    expect(merged.fiveHour?.pct).toBe(70);
    expect(merged.sevenDay?.pct).toBe(10);
    expect(merged.source).toBe('statusline');
    expect(merged.unavailable).toBe('error');
  });

  test('an older observation changes nothing', () => {
    const prev = usage();
    const merged = mergeUsage(prev, { fiveHour: { pct: 99, resetsAt: null }, sevenDay: null, source: 'poll', observedAt: NOW - MIN });
    expect(merged).toBe(prev);
  });

  test('a successful poll clears the unavailable marker', () => {
    const merged = mergeUsage(usage({ unavailable: 'reauth' }), {
      fiveHour: { pct: 1, resetsAt: null }, sevenDay: null, source: 'poll', observedAt: NOW + 1,
    });
    expect(merged.unavailable).toBeNull();
  });
});

describe('thresholds', () => {
  test('over on fresh data at or above the threshold, in either window', () => {
    expect(isOverThreshold(usage({ sevenDay: { pct: 85, resetsAt: null } }), 85, NOW)).toBe(true);
    expect(isOverThreshold(usage(), 85, NOW)).toBe(false);
  });

  test('no data and stale data are never over', () => {
    expect(isOverThreshold(null, 85, NOW)).toBe(false);
    expect(isOverThreshold(emptyUsage('work'), 85, NOW)).toBe(false);
    const stale = usage({ fiveHour: { pct: 99, resetsAt: null }, observedAt: NOW - USAGE_STALE_MS - 1 });
    expect(isOverThreshold(stale, 85, NOW)).toBe(false);
  });

  test('a window past its reset counts as started over', () => {
    const reset = usage({ fiveHour: { pct: 99, resetsAt: NOW - 1 } });
    expect(isOverThreshold(reset, 85, NOW)).toBe(false);
  });

  test('levels: ok, warn, critical, unknown', () => {
    expect(usageLevel(usage(), 85, NOW)).toBe('ok');
    expect(usageLevel(usage({ fiveHour: { pct: 90, resetsAt: null } }), 85, NOW)).toBe('warn');
    expect(usageLevel(usage({ fiveHour: { pct: 100, resetsAt: null } }), 85, NOW)).toBe('critical');
    expect(usageLevel(null, 85, NOW)).toBe('unknown');
  });

  test('the preference falls back to 85 when unset or out of range', () => {
    expect(parseUsageThreshold(null)).toBe(85);
    expect(parseUsageThreshold('')).toBe(85);
    expect(parseUsageThreshold('abc')).toBe(85);
    expect(parseUsageThreshold('0')).toBe(85);
    expect(parseUsageThreshold('150')).toBe(85);
    expect(parseUsageThreshold('70')).toBe(70);
  });
});

describe('ThresholdNotices', () => {
  const over = (pct: number, resetsAt: number | null) => usage({ fiveHour: { pct, resetsAt } });

  test('announces a crossing once per window, however often it is re-read', () => {
    const notices = new ThresholdNotices();
    expect(notices.check(over(90, NOW + 40 * MIN), 85, NOW)).toHaveLength(1);
    expect(notices.check(over(93, NOW + 40 * MIN + 1000), 85, NOW)).toHaveLength(0);
    expect(notices.check(over(97, NOW + 40 * MIN), 85, NOW + MIN)).toHaveLength(0);
  });

  test('a new window after the reset announces again', () => {
    const notices = new ThresholdNotices();
    notices.check(over(90, NOW + 40 * MIN), 85, NOW);
    expect(notices.check(over(90, NOW + 5 * 60 * MIN), 85, NOW + 41 * MIN)).toHaveLength(1);
  });

  test('below the threshold says nothing', () => {
    expect(new ThresholdNotices().check(over(50, NOW + MIN), 85, NOW)).toHaveLength(0);
  });

  test('the copy names the account, percent, window and reset', () => {
    const text = describeCrossing('Work', { accountId: 'work', window: 'fiveHour', pct: 92.4, resetsAt: NOW + 40 * MIN }, NOW);
    expect(text).toBe('Work is at 92% of its 5-hour limit, resets in 40m');
  });
});

test('formatDuration', () => {
  expect(formatDuration(40 * MIN)).toBe('40m');
  expect(formatDuration(185 * MIN)).toBe('3h 5m');
  expect(formatDuration(52 * 60 * MIN)).toBe('2d 4h');
  expect(formatDuration(-5)).toBe('0m');
});
