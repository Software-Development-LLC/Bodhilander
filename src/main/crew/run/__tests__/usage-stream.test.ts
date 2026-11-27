import { describe, expect, test } from 'bun:test';
import { costMicroUsd, parseRateLimitEvent, runUsage } from '../usage-stream';
import { emptyUsage, mergeUsage } from '../../../usage-meter';

describe('the start-of-run window reading', () => {
  test('seven_day at 0.47 reads as 47%, stamped with Crew\'s time; an unreported window stays null', () => {
    const obs = parseRateLimitEvent({ type: 'rate_limit_event', unifiedWindows: { seven_day: { utilization: 0.47, resetsAt: 1_800_000_000, status: 'allowed' } } }, 5000);
    expect(obs).toEqual({ fiveHour: null, sevenDay: { pct: 47, resetsAt: 1_800_000_000_000, observedAt: 5000 }, source: 'run', observedAt: 5000 });
  });

  test('a list of windows, and both windows, are read', () => {
    const obs = parseRateLimitEvent({ type: 'rate_limit_event', unifiedWindows: [{ window: 'five_hour', utilization: 0.1 }, { window: 'seven_day', utilization: 0.2 }] }, 1);
    expect([obs?.fiveHour?.pct, obs?.sevenDay?.pct]).toEqual([10, 20]);
  });

  test('another event, no windows, or a malformed reading gives nothing', () => {
    expect(parseRateLimitEvent({ type: 'result' }, 1)).toBeNull();
    expect(parseRateLimitEvent({ type: 'rate_limit_event' }, 1)).toBeNull();
    expect(parseRateLimitEvent({ type: 'rate_limit_event', unifiedWindows: { seven_day: { utilization: '0.4' } } }, 1)).toBeNull();
    expect(parseRateLimitEvent({ type: 'rate_limit_event', unifiedWindows: { seven_day: { utilization: -1 } } }, 1)).toBeNull();
  });

  test('merged into the meter when newer, left alone when the meter is newer', () => {
    const run = parseRateLimitEvent({ type: 'rate_limit_event', unifiedWindows: { seven_day: { utilization: 0.47 } } }, 2000)!;
    const older = { ...emptyUsage('a1'), sevenDay: { pct: 30, resetsAt: null, observedAt: 1000 }, observedAt: 1000, source: 'poll' as const };
    expect(mergeUsage(older, run).sevenDay?.pct).toBe(47);
    const newer = { ...older, sevenDay: { pct: 50, resetsAt: null, observedAt: 3000 }, observedAt: 3000 };
    expect(mergeUsage(newer, run).sevenDay?.pct).toBe(50);
  });
});

describe('the run\'s own cost', () => {
  test('priced from result.usage, never the session total', () => {
    const turns = [
      { total_cost_usd: 3.14, usage: { input_tokens: 10, cache_creation_input_tokens: 400_000, cache_read_input_tokens: 0, output_tokens: 18_000 } },
      { total_cost_usd: 3.25, usage: { input_tokens: 10, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 150_000, output_tokens: 500 } },
      { total_cost_usd: 3.33, usage: { input_tokens: 10, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 120_000, output_tokens: 500 } },
    ];
    const costs = turns.map((t) => costMicroUsd(runUsage(t)));
    expect(costs).toEqual([2_950_050, 100_050, 78_800]);
    for (const [i, c] of costs.entries()) expect(c).toBeLessThan(turns[i].total_cost_usd * 1_000_000);
  });

  test('a missing or bad count is 0', () => {
    expect(runUsage({ usage: { input_tokens: -1, output_tokens: 'x' } })).toEqual({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
    expect(runUsage(null).output_tokens).toBe(0);
  });
});
