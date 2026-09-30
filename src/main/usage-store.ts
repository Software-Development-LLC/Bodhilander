import { AccountUsage, AccountUsageMap } from '../shared/types';
import { isOverThreshold, parseUsageThreshold, USAGE_THRESHOLD_PREF } from '../shared/usage';
import { getPreference } from './repositories/preferences';

/**
 * The merged usage record for every account, held in memory. The poller writes
 * it; routing and the IPC surface read it. An account with no record routes
 * exactly as it did before usage was measured.
 */


const records = new Map<string, AccountUsage>();

export function getUsage(accountId: string): AccountUsage | null {
  return records.get(accountId) ?? null;
}

export function setUsage(usage: AccountUsage): void {
  records.set(usage.accountId, usage);
}

export function forgetUsage(accountId: string): void {
  records.delete(accountId);
}

export function allUsage(): AccountUsageMap {
  return Object.fromEntries(records);
}

export function clearAllUsage(): void {
  records.clear();
}

export function getUsageThreshold(): number {
  try {
    return parseUsageThreshold(getPreference(USAGE_THRESHOLD_PREF));
  } catch {
    return parseUsageThreshold(null);
  }
}

/** Near its limit on fresh data, so not to be preferred for new work. */
export function isUsagePressured(accountId: string, now: Date = new Date()): boolean {
  const usage = getUsage(accountId);
  return usage !== null && isOverThreshold(usage, getUsageThreshold(), now.getTime());
}
