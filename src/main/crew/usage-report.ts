/**
 * One usage record per finished run, for the Hub: the run's own tokens, its
 * cost-equivalent, and the account's windows as merged from the run's reading
 * and the meter, whichever is newer per window.
 */
import type { AccountUsage, UsageWindow as LocalWindow } from '../../shared/types';
import { emptyUsage, mergeUsage, type UsageObservation } from '../usage-meter';
import type { UsageWindow } from './protocol';
import type { UsageInput } from './hub-client';
import type { FinishedRun } from './run/loop';
import { costMicroUsd, type Price } from './run/usage-stream';

/** The run's start-of-run reading folded into the account's record. */
export function mergeRunObservation(
  accountId: string,
  observation: UsageObservation,
  store: { get(id: string): AccountUsage | null; set(u: AccountUsage): void },
): AccountUsage {
  const merged = mergeUsage(store.get(accountId) ?? emptyUsage(accountId), observation);
  store.set(merged);
  return merged;
}

/** Windows on the wire; one not read is left out, never sent as 0%. */
export function wireWindows(usage: AccountUsage | null): UsageWindow[] {
  const out: UsageWindow[] = [];
  const add = (name: string, w: LocalWindow | null) => {
    if (w) out.push({ name, utilization: w.pct / 100, resetsAt: w.resetsAt ?? 0, status: 'observed' });
  };
  add('five_hour', usage?.fiveHour ?? null);
  add('seven_day', usage?.sevenDay ?? null);
  return out;
}

export function usageRecordFor(run: FinishedRun, accountUuid: string, account: AccountUsage | null, price?: Price): UsageInput {
  return {
    runId: run.runId,
    requestedBy: run.job.requestedBy,
    accountUuid,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    model: run.model,
    inputTokens: run.usage.input_tokens,
    outputTokens: run.usage.output_tokens,
    cacheCreationTokens: run.usage.cache_creation_input_tokens,
    cacheReadTokens: run.usage.cache_read_input_tokens,
    costEquivalentMicroUsd: costMicroUsd(run.usage, price),
    windows: wireWindows(account),
    windowsReadAt: account?.observedAt ?? run.startedAt,
  };
}
