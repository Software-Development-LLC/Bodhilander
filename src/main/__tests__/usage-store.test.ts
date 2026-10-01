/**
 * What routing reads from the usage record: known room and signed-out
 * accounts. Run with: bun test <this file>
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('../repositories/preferences', () => ({ getPreference: () => null }));

const usageStore = await import('../usage-store');
const { emptyUsage, mergeUsage } = await import('../usage-meter');
import type { AccountUsage, UsageSource, UsageUnavailableReason, UsageWindow } from '../../shared/types';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const MIN = 60_000;
const RESET = NOW + 60 * MIN;
const at = new Date(NOW);

const w = (pct: number, resetsAt: number | null, observedAt: number): UsageWindow => ({ pct, resetsAt, observedAt });

function observe(prev: AccountUsage, source: UsageSource, observedAt: number, windows: Partial<AccountUsage>) {
  return mergeUsage(prev, { fiveHour: null, sevenDay: null, ...windows, source, observedAt });
}

beforeEach(() => usageStore.clearAllUsage());

describe('hasFreshRoom', () => {
  test('a fresh poll under the threshold is room', () => {
    usageStore.setUsage(observe(emptyUsage('work'), 'poll', NOW, { fiveHour: w(30, RESET, NOW) }));
    expect(usageStore.hasFreshRoom('work', at, 85)).toBe(true);
  });

  test('an idle CLI replaying 30% neither replaces a fresh 88% nor makes room', () => {
    const polled = observe(emptyUsage('work'), 'poll', NOW - 5 * MIN, { fiveHour: w(88, RESET, NOW - 5 * MIN) });
    usageStore.setUsage(observe(polled, 'statusline', NOW, { fiveHour: w(30, RESET, NOW) }));
    expect(usageStore.getUsage('work')?.fiveHour?.pct).toBe(88);
    expect(usageStore.hasFreshRoom('work', at, 85)).toBe(false);
  });

  test('a window carried over from hours ago, with no reset time, is not room', () => {
    const old = NOW - 3 * 60 * MIN;
    const carried = observe(emptyUsage('work'), 'poll', old, { fiveHour: w(10, null, old) });
    usageStore.setUsage(observe(carried, 'poll', NOW, { sevenDay: w(20, NOW + 3 * 24 * 60 * MIN, NOW) }));
    expect(usageStore.getUsage('work')?.fiveHour).toEqual(w(10, null, old));
    expect(usageStore.hasFreshRoom('work', at, 85)).toBe(false);
  });

  test('fresh room on an account whose Keychain cannot be read is not room', () => {
    const polled = observe(emptyUsage('work'), 'poll', NOW, { fiveHour: w(30, RESET, NOW) });
    usageStore.setUsage({ ...polled, unavailable: 'keychain-unavailable' });
    expect(usageStore.hasFreshRoom('work', at, 85)).toBe(false);
  });
});

describe('signed out', () => {
  const markedAs = (unavailable: UsageUnavailableReason) => {
    usageStore.setUsage({ ...emptyUsage('work'), unavailable });
    return [usageStore.isSignedOut('work'), usageStore.isUnreachable('work')];
  };

  test.each(['reauth', 'no-credentials', 'no-keychain-credentials'] as const)('%s is signed out', (reason) => {
    expect(markedAs(reason)).toEqual([true, true]);
  });

  test('an unreadable Keychain is out of reach without being signed out', () => {
    expect(markedAs('keychain-unavailable')).toEqual([false, true]);
  });

  test('a failed poll is neither', () => {
    expect(markedAs('error')).toEqual([false, false]);
  });
});

describe('a held token rotation', () => {
  test('fresh room on an account holding its pair in memory is not room, and asks for relief', () => {
    usageStore.setUsage(observe(emptyUsage('work'), 'poll', NOW, { fiveHour: w(30, RESET, NOW) }));
    usageStore.markRotationHeld('work');
    expect([usageStore.hasFreshRoom('work', at, 85), usageStore.isSignedOut('work'), usageStore.needsRelief('work', at, 85)])
      .toEqual([false, false, true]);
    usageStore.clearRotationHeld('work');
    expect([usageStore.hasFreshRoom('work', at, 85), usageStore.needsRelief('work', at, 85)]).toEqual([true, false]);
  });
});
