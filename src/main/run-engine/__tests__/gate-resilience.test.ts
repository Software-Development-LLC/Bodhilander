/**
 * Gate quota-resilience (CO-722 R1).
 *
 * The one distinction that must be right: a **usage cap** holds (retrying only
 * burns launches into the same 429), a **transient** API error retries. The cap
 * is read from the CLI's own structured quota entry, never guessed -- so these
 * tests pin that a cap is NOT retried and a transient IS, and that everything
 * that is not an api_error undriveable passes straight through.
 *
 * Run with: bun test src/main/run-engine/__tests__/gate-resilience.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { runGateResilient, type GateResilienceDeps } from '../gate-resilience';
import type { GateOutcome } from '../gate-process';
import type { QuotaLimitHit } from '../../quota-limit';

const completed: GateOutcome = { status: 'completed', structuredOutput: { verdict: 'pass' }, sessionId: 's', costUsd: 0, durationMs: 1 };
const apiError: GateOutcome = { status: 'undriveable', reason: 'the gate reported success (api_error)', detail: null, durationMs: 1, apiError: true };
const timeout: GateOutcome = { status: 'undriveable', reason: 'the gate did not finish within 1000ms', detail: null, durationMs: 1 };

/** A `run` that returns each queued outcome in turn (last repeats), counting calls. */
function runner(outcomes: GateOutcome[]): { run: () => Promise<GateOutcome>; calls: () => number } {
  let i = 0;
  return {
    run: async () => outcomes[Math.min(i++, outcomes.length - 1)],
    calls: () => i,
  };
}

function deps(over: Partial<GateResilienceDeps> & Pick<GateResilienceDeps, 'run'>): GateResilienceDeps {
  return {
    configDir: 'C:/acct/.claude',
    sessionId: 'conv-1',
    startedAt: new Date('2026-09-21T00:00:00Z'),
    markLimited: () => {},
    accountIdForDir: () => 'acct-1',
    readQuota: () => null, // no cap unless a test says so
    sleep: async () => {}, // no real waiting
    retries: 2,
    delayMs: () => 0,
    log: () => {},
    ...over,
  };
}

describe('what passes straight through', () => {
  test('a completed gate is returned as-is, run once', async () => {
    const r = runner([completed]);
    const out = await runGateResilient(deps({ run: r.run }));
    expect(out).toEqual(completed);
    expect(r.calls()).toBe(1);
  });

  test('a non-api_error undriveable (timeout) is not retried', async () => {
    const r = runner([timeout]);
    const out = await runGateResilient(deps({ run: r.run }));
    expect(out).toEqual(timeout);
    expect(r.calls()).toBe(1);
  });
});

describe('a usage cap holds -- never retried', () => {
  const hit: QuotaLimitHit = { resetAt: new Date('2026-09-21T04:00:00Z'), rateLimitType: 'seven_day', observedAt: null };

  test('marks the account limited, rewrites the reason, and does NOT retry', async () => {
    const r = runner([apiError]);
    const marked: Array<{ id: string; until: Date }> = [];
    const out = await runGateResilient(deps({
      run: r.run,
      readQuota: () => hit,
      markLimited: (id, until) => marked.push({ id, until }),
    }));
    expect(r.calls()).toBe(1); // held, not retried
    expect(marked).toEqual([{ id: 'acct-1', until: hit.resetAt }]);
    if (out.status !== 'undriveable') throw new Error('expected undriveable');
    expect(out.reason).toContain('weekly limit');
    expect(out.reason).toContain(hit.resetAt.toISOString());
  });

  test('a cap with no known account still holds (no mark, no retry)', async () => {
    const r = runner([apiError]);
    const out = await runGateResilient(deps({
      run: r.run,
      readQuota: () => hit,
      accountIdForDir: () => null,
    }));
    expect(r.calls()).toBe(1);
    expect(out.status).toBe('undriveable');
  });
});

describe('a transient api_error retries, bounded', () => {
  test('retries up to the ceiling then returns the last outcome', async () => {
    const r = runner([apiError, apiError, apiError, apiError]); // always transient
    const out = await runGateResilient(deps({ run: r.run, retries: 2 }));
    expect(r.calls()).toBe(3); // first + 2 retries
    expect(out).toEqual(apiError);
  });

  test('a retry that succeeds returns the success', async () => {
    const r = runner([apiError, completed]);
    const out = await runGateResilient(deps({ run: r.run }));
    expect(r.calls()).toBe(2);
    expect(out).toEqual(completed);
  });

  test('backoff is awaited between retries', async () => {
    const r = runner([apiError, apiError, completed]);
    const waits: number[] = [];
    const out = await runGateResilient(deps({
      run: r.run,
      sleep: async (ms) => { waits.push(ms); },
      delayMs: (n) => n * 100,
    }));
    expect(out).toEqual(completed);
    expect(waits).toEqual([100, 200]);
  });
});
