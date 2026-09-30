import { AccountUsage, UsageSource, UsageWindow } from '../shared/types';
import { describeWindow, formatDuration, currentPct, UsageWindowName, USAGE_WINDOWS } from '../shared/usage';

/**
 * Usage from the undocumented `/api/oauth/usage` endpoint and the statusline's
 * `rate_limits`. An unrecognised shape is "no data", never 0%.
 */

export interface UsageObservation {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  source: UsageSource;
  observedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** ISO string or epoch (seconds or ms) to epoch ms; anything else is null. */
function parseInstant(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

type WindowParse = UsageWindow | null | 'invalid';

function parseWindow(value: unknown, pctKey: string, resetKey: string): WindowParse {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return 'invalid';
  const pct = value[pctKey];
  if (pct === null) return null;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) return 'invalid';
  const rawReset = value[resetKey];
  const resetsAt = parseInstant(rawReset);
  if (resetsAt === null && rawReset !== null && rawReset !== undefined) return 'invalid';
  return { pct, resetsAt };
}

function observation(
  fiveHour: WindowParse,
  sevenDay: WindowParse,
  source: UsageSource,
  observedAt: number,
): UsageObservation | null {
  if (fiveHour === 'invalid' || sevenDay === 'invalid') return null;
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, source, observedAt };
}

/** The `/api/oauth/usage` body. A window that is absent or has no utilization is skipped. */
export function parseOAuthUsage(body: unknown, observedAt: number): UsageObservation | null {
  if (!isRecord(body)) return null;
  return observation(
    parseWindow(body.five_hour, 'utilization', 'resets_at'),
    parseWindow(body.seven_day, 'utilization', 'resets_at'),
    'poll',
    observedAt,
  );
}

/** What the statusline sink wrote: `{ observedAt, rate_limits }`. */
export function parseStatuslineSink(body: unknown): UsageObservation | null {
  if (!isRecord(body) || !isRecord(body.rate_limits)) return null;
  const observedAt = typeof body.observedAt === 'number' ? body.observedAt : null;
  if (observedAt === null || !Number.isFinite(observedAt)) return null;
  const limits = body.rate_limits;
  return observation(
    parseWindow(limits.five_hour, 'used_percentage', 'resets_at'),
    parseWindow(limits.seven_day, 'used_percentage', 'resets_at'),
    'statusline',
    observedAt,
  );
}

export function emptyUsage(accountId: string): AccountUsage {
  return { accountId, fiveHour: null, sevenDay: null, source: null, observedAt: null, unavailable: null };
}

/**
 * Fold one observation into a record. The newer observation wins; a window it
 * does not report keeps the older value rather than being erased.
 */
export function mergeUsage(prev: AccountUsage, obs: UsageObservation): AccountUsage {
  if (prev.observedAt !== null && obs.observedAt < prev.observedAt) return prev;
  return {
    accountId: prev.accountId,
    fiveHour: obs.fiveHour ?? prev.fiveHour,
    sevenDay: obs.sevenDay ?? prev.sevenDay,
    source: obs.source,
    observedAt: obs.observedAt,
    unavailable: obs.source === 'poll' ? null : prev.unavailable,
  };
}

export interface ThresholdCrossing {
  accountId: string;
  window: UsageWindowName;
  pct: number;
  resetsAt: number | null;
}

/** Resets within this of the last notified one are the same window, not a new one. */
const SAME_WINDOW_SLACK_MS = 10 * 60 * 1000;

/**
 * Remembers which windows have been announced, so a crossing is announced once
 * per account per window reset however many readings repeat it.
 */
export class ThresholdNotices {
  private readonly notified = new Map<string, number | null>();

  check(usage: AccountUsage, threshold: number, now: number): ThresholdCrossing[] {
    const crossings: ThresholdCrossing[] = [];
    for (const name of USAGE_WINDOWS) {
      const window = usage[name];
      const pct = currentPct(window, now);
      const key = `${usage.accountId}:${name}`;
      // Without a reset time, dropping back under is the only sign of a new window.
      if (window?.resetsAt === null && pct !== null && pct < threshold) this.notified.delete(key);
      if (!window || pct === null || pct < threshold) continue;
      if (this.notified.has(key) && this.isSameWindow(this.notified.get(key) ?? null, window.resetsAt)) continue;
      this.notified.set(key, window.resetsAt);
      crossings.push({ accountId: usage.accountId, window: name, pct, resetsAt: window.resetsAt });
    }
    return crossings;
  }

  private isSameWindow(previous: number | null, next: number | null): boolean {
    if (previous === null || next === null) return previous === next;
    return next <= previous + SAME_WINDOW_SLACK_MS;
  }
}

/** "Work is at 92% of its 5-hour limit, resets in 40m". */
export function describeCrossing(label: string, crossing: ThresholdCrossing, now: number): string {
  const pct = Math.round(crossing.pct);
  const base = `${label} is at ${pct}% of its ${describeWindow(crossing.window)}`;
  if (crossing.resetsAt === null) return base;
  return `${base}, resets in ${formatDuration(crossing.resetsAt - now)}`;
}
