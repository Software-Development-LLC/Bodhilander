/**
 * UsageMeters: one account's 5-hour and weekly readings.
 * Run with: bun test src/renderer/components/__tests__/UsageMeters.test.tsx
 */
import React from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { UsageMeters } from '../UsageMeters';
import { AccountUsage } from '../../../shared/types';

afterEach(cleanup);

const NOW = Date.parse('2026-09-30T12:00:00Z');
const MIN = 60_000;

function usage(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    accountId: 'a1',
    fiveHour: { pct: 50, resetsAt: NOW + 90 * MIN },
    sevenDay: null,
    source: 'statusline',
    observedAt: NOW - 30_000,
    unavailable: null,
    ...over,
  };
}

const text = () => document.querySelector('.usage-meters')!.textContent;

describe('UsageMeters', () => {
  test('a window nobody reported is left out, not shown as 0%', () => {
    render(<UsageMeters usage={usage()} threshold={85} now={NOW} />);
    expect(text()).toBe('5h50%resets in 1h 30mas of just now');
  });

  test('a window past its reset shows 0% and no countdown', () => {
    render(<UsageMeters usage={usage({ fiveHour: { pct: 99, resetsAt: NOW - MIN } })} threshold={85} now={NOW} />);
    expect(text()).toContain('0%');
    expect(text()).not.toContain('resets in');
  });

  test('colour follows the threshold, and 100% is critical', () => {
    render(<UsageMeters usage={usage({ fiveHour: { pct: 60, resetsAt: null }, sevenDay: { pct: 100, resetsAt: null } })} threshold={55} now={NOW} />);
    expect(document.querySelectorAll('.usage-warn')).toHaveLength(1);
    expect(document.querySelectorAll('.usage-critical')).toHaveLength(1);
  });

  test('a failed latest poll is said beside the readings still held', () => {
    render(<UsageMeters usage={usage({ unavailable: 'error' })} threshold={85} now={NOW} />);
    expect(text()).toContain('50%');
    expect(text()).toContain('usage unavailable');
  });

  test('no token file on this platform is named', () => {
    render(<UsageMeters usage={usage({ fiveHour: null, observedAt: null, unavailable: 'no-credentials' })} threshold={85} now={NOW} />);
    expect(text()).toBe('usage unavailable (no token file for this account)');
  });

  test('a Mac with no Keychain sign-in says so, not that a token file is missing', () => {
    render(<UsageMeters usage={usage({ fiveHour: null, observedAt: null, unavailable: 'no-keychain-credentials' })} threshold={85} now={NOW} />);
    expect(text()).toBe('usage unavailable (no Keychain sign-in for this account)');
  });
});
