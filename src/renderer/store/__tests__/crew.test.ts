import { describe, expect, test } from 'bun:test';
import { activityText, availabilityText, formatTokens, hireTokenTotal, parseDailyCap } from '../crew';
import type { CrewHireSummary } from '../../../shared/types';

const hire = (over: Partial<CrewHireSummary>): CrewHireSummary => ({
  hireId: 'h',
  name: 'Fresh PO',
  roleId: 'fresh-po',
  state: 'active',
  activity: 'idle',
  cause: null,
  accountLabel: null,
  ...over,
});

describe('availability', () => {
  test('online has nothing to say', () => {
    expect(availabilityText('online')).toBeNull();
  });

  test('no Hub reads as unavailable, in words, never as an error', () => {
    expect(availabilityText('unavailable')).toBe("Crew isn't available right now");
    expect(availabilityText('update-required')).toBe('Update Bodhilander to use Crew');
    expect(availabilityText('key-unavailable')).toBe('Crew needs the system keychain');
  });
});

describe('hire state', () => {
  test('a hold says why', () => {
    expect(activityText(hire({ activity: 'held', cause: 'signed-out' }))).toBe('Held: signed out');
    expect(activityText(hire({ activity: 'held', cause: 'crew-cap' }))).toBe('Held: account cap reached');
  });

  test('an unknown cause is shown as it came', () => {
    expect(activityText(hire({ activity: 'held', cause: 'something-new' }))).toBe('Held: something-new');
  });

  test('running, idle and elsewhere', () => {
    expect(activityText(hire({ activity: 'running' }))).toBe('Running');
    expect(activityText(hire({ activity: 'idle' }))).toBe('Idle');
    expect(activityText(hire({ activity: 'elsewhere' }))).toBe('On another machine');
  });
});

describe('tokens', () => {
  test('are counted, not priced', () => {
    expect(formatTokens(1_234_567)).toBe('1,234,567 tokens');
    expect(formatTokens(1)).toBe('1 token');
  });

  test('the 7-day total is the three capped counts', () => {
    expect(hireTokenTotal({ available: true, since: 0, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 2, records: 1 })).toBe(17);
  });

  test('a failed read has no total, so nothing can render it as 0', () => {
    expect(hireTokenTotal({ available: false, reason: 'offline' })).toBeNull();
  });
});

describe('the daily cap field', () => {
  test('empty is off', () => {
    expect(parseDailyCap('  ')).toEqual({ ok: true, cap: null });
  });

  test('accepts thousands separators', () => {
    expect(parseDailyCap('500,000')).toEqual({ ok: true, cap: 500_000 });
  });

  test('refuses zero, fractions and words', () => {
    for (const bad of ['0', '1.5', 'lots', '-3']) expect(parseDailyCap(bad).ok).toBe(false);
  });
});
