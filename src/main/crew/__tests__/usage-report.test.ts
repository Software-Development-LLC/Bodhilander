import { describe, expect, test } from 'bun:test';
import type { AccountUsage } from '../../../shared/types';
import { mergeRunObservation, usageRecordFor, wireWindows } from '../usage-report';
import type { FinishedRun } from '../run/loop';
import { HIRE, PERSON, uuid } from './crew-db';

const run: FinishedRun = {
  runId: uuid(1),
  job: { id: uuid(2), hireId: HIRE, kind: 'message', epoch: 1, scope: 'owner', requestedBy: PERSON, sender: 'B', text: '', attempts: 1 },
  accountId: 'acct',
  startedAt: 1_000,
  durationMs: 50,
  model: 'claude-opus',
  usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 100 },
  observation: null,
};

describe('usage report', () => {
  test('the run reading merges into the account record only where it is newer', () => {
    const records = new Map<string, AccountUsage>();
    const store = { get: (id: string) => records.get(id) ?? null, set: (u: AccountUsage) => void records.set(u.accountId, u) };
    store.set({ accountId: 'acct', fiveHour: { pct: 10, resetsAt: 9, observedAt: 500 }, sevenDay: { pct: 70, resetsAt: 9, observedAt: 500 }, source: 'poll', observedAt: 500, unavailable: null });
    const merged = mergeRunObservation('acct', { fiveHour: { pct: 30, resetsAt: 9, observedAt: 900 }, sevenDay: null, source: 'run', observedAt: 900 }, store);
    expect(merged.fiveHour?.pct).toBe(30);
    expect(merged.sevenDay?.pct).toBe(70);
    mergeRunObservation('acct', { fiveHour: { pct: 1, resetsAt: 9, observedAt: 100 }, sevenDay: null, source: 'run', observedAt: 100 }, store);
    expect(records.get('acct')?.fiveHour?.pct).toBe(30);
  });

  test('a record carries the run tokens, its cost-equivalent and only the windows read', () => {
    const account: AccountUsage = { accountId: 'acct', fiveHour: { pct: 40, resetsAt: 5_000, observedAt: 900 }, sevenDay: null, source: 'run', observedAt: 900, unavailable: null };
    const record = usageRecordFor(run, 'u-acct', account);
    expect(record).toEqual({
      runId: uuid(1), requestedBy: PERSON, accountUuid: 'u-acct', startedAt: 1_000, durationMs: 50, model: 'claude-opus', inputTokens: 1000,
      outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 2000, costEquivalentMicroUsd: 1000 * 5 + 2000 * 0.5 + 100 * 25,
      windows: [{ name: 'five_hour', utilization: 0.4, resetsAt: 5_000, status: 'observed' }], windowsReadAt: 900,
    });
    expect(wireWindows(null)).toEqual([]);
    expect(usageRecordFor(run, 'u', null).windowsReadAt).toBe(1_000);
  });
});
