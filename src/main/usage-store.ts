import { AccountUsage, AccountUsageMap, UsageUnavailableReason } from '../shared/types';
import { allWindowsFresh, isOverThreshold, parseUsageThreshold, peakPct, USAGE_THRESHOLD_PREF } from '../shared/usage';
import { getPreference } from './repositories/preferences';

/**
 * The merged usage record for every account, held in memory. The poller writes
 * it; routing and the IPC surface read it. An account with no record routes
 * exactly as it did before usage was measured.
 */

const records = new Map<string, AccountUsage>();
/** Accounts holding a refreshed pair their store has not taken yet. */
const heldRotations = new Set<string>();

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

export function markRotationHeld(accountId: string): void {
  heldRotations.add(accountId);
}

export function clearRotationHeld(accountId: string): void {
  heldRotations.delete(accountId);
}

export function hasHeldRotation(accountId: string): boolean {
  return heldRotations.has(accountId);
}

export function clearAllUsage(): void {
  records.clear();
  heldRotations.clear();
}

export function getUsageThreshold(): number {
  try {
    return parseUsageThreshold(getPreference(USAGE_THRESHOLD_PREF));
  } catch {
    return parseUsageThreshold(null);
  }
}

/** Near its limit on fresh data, so not to be preferred for new work. */
export function isUsagePressured(
  accountId: string,
  now: Date = new Date(),
  threshold: number = getUsageThreshold(),
): boolean {
  const usage = getUsage(accountId);
  return usage !== null && isOverThreshold(usage, threshold, now.getTime());
}

/**
 * Room to go back to: a stale reading last seen over the threshold still counts
 * as full until a fresh one says otherwise or its window resets.
 */
export function hasUsageRoom(
  accountId: string,
  now: Date = new Date(),
  threshold: number = getUsageThreshold(),
): boolean {
  const peak = peakPct(getUsage(accountId), now.getTime());
  return peak === null || peak < threshold;
}

const SIGNED_OUT: ReadonlySet<UsageUnavailableReason> = new Set(['reauth', 'no-credentials', 'no-keychain-credentials']);

/** The last poll found no usable sign-in for the account. */
export function isSignedOut(accountId: string): boolean {
  const reason = getUsage(accountId)?.unavailable;
  return reason != null && SIGNED_OUT.has(reason);
}

/** Signed out, its Keychain item unreadable, or its live tokens only in memory: out of reach either way. */
export function isUnreachable(accountId: string): boolean {
  return isSignedOut(accountId) || getUsage(accountId)?.unavailable === 'keychain-unavailable' || hasHeldRotation(accountId);
}

/** Near its limit, or its live tokens only in memory: new work goes elsewhere when it can. */
export function needsRelief(
  accountId: string,
  now: Date = new Date(),
  threshold: number = getUsageThreshold(),
): boolean {
  return isUsagePressured(accountId, now, threshold) || hasHeldRotation(accountId);
}

/**
 * Known room: every window fresh and below the threshold, on an account whose
 * tokens are in reach. Only this justifies a usage-driven move onto an account.
 */
export function hasFreshRoom(
  accountId: string,
  now: Date = new Date(),
  threshold: number = getUsageThreshold(),
): boolean {
  const usage = getUsage(accountId);
  if (!allWindowsFresh(usage, now.getTime()) || isUnreachable(accountId)) return false;
  const peak = peakPct(usage, now.getTime());
  return peak !== null && peak < threshold;
}
