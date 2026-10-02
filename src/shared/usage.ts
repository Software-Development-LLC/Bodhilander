import { AccountUsage, UsageWindow } from './types';

/**
 * Pure usage-record helpers shared by main (routing, notices) and the renderer
 * (meters), so both sides judge "near the limit" and "stale" the same way.
 */

/** Preference key for the warning threshold; absent means the default. */
export const USAGE_THRESHOLD_PREF = 'usageWarnThreshold';
export const DEFAULT_USAGE_WARN_THRESHOLD = 85;

/** Preference key for installing the statusline sink; absent means on. */
export const USAGE_SINK_PREF = 'usageStatuslineSink';

export function isSinkEnabled(raw: string | null | undefined): boolean {
  return raw !== 'false';
}

/** Older than this, a reading is marked stale and no longer steers routing. */
export const USAGE_STALE_MS = 15 * 60 * 1000;

export type UsageWindowName = 'fiveHour' | 'sevenDay';

export const USAGE_WINDOWS: readonly UsageWindowName[] = ['fiveHour', 'sevenDay'];

export type UsageLevel = 'ok' | 'warn' | 'critical' | 'unknown';

/** A window whose reset has passed has started over, so its old percent is void. */
export function currentPct(window: UsageWindow | null, now: number): number | null {
  if (!window) return null;
  if (window.resetsAt !== null && window.resetsAt <= now) return 0;
  return window.pct;
}

export function isUsageStale(usage: AccountUsage | null | undefined, now: number): boolean {
  if (usage?.observedAt == null) return true;
  return now - usage.observedAt > USAGE_STALE_MS;
}

/** The highest current percent across both windows, or null with no data. */
export function peakPct(usage: AccountUsage | null | undefined, now: number): number | null {
  if (!usage) return null;
  let peak: number | null = null;
  for (const name of USAGE_WINDOWS) {
    const pct = currentPct(usage[name], now);
    if (pct !== null && (peak === null || pct > peak)) peak = pct;
  }
  return peak;
}

/** Every window the record reports was itself observed recently. */
export function allWindowsFresh(usage: AccountUsage | null | undefined, now: number): boolean {
  const windows = USAGE_WINDOWS.map(name => usage?.[name] ?? null).filter((w): w is UsageWindow => w !== null);
  return windows.length > 0 && windows.every(window => now - window.observedAt <= USAGE_STALE_MS);
}

export function levelForPct(pct: number, threshold: number): UsageLevel {
  if (pct >= 100) return 'critical';
  if (pct >= threshold) return 'warn';
  return 'ok';
}

export function usageLevel(
  usage: AccountUsage | null | undefined,
  threshold: number,
  now: number,
): UsageLevel {
  const peak = peakPct(usage, now);
  if (peak === null || isUsageStale(usage, now)) return 'unknown';
  return levelForPct(peak, threshold);
}

/** Over the threshold on fresh data. No data or stale data is never "over". */
export function isOverThreshold(
  usage: AccountUsage | null | undefined,
  threshold: number,
  now: number,
): boolean {
  if (isUsageStale(usage, now)) return false;
  const peak = peakPct(usage, now);
  return peak !== null && peak >= threshold;
}

/** A threshold preference value, or the default when unset or out of range. */
export function parseUsageThreshold(raw: string | null | undefined): number {
  const value = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(value)) return DEFAULT_USAGE_WARN_THRESHOLD;
  if (value < 1 || value > 100) return DEFAULT_USAGE_WARN_THRESHOLD;
  return Math.round(value);
}

/** "40m", "3h 5m", "2d 4h". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

export function describeWindow(name: UsageWindowName): string {
  return name === 'fiveHour' ? '5-hour limit' : 'weekly limit';
}

/** Written by the statusline command into each managed config dir. */
export const STATUSLINE_SINK_FILE = 'bodhilander-usage.json';

/** Holds the user's own statusLine entry, which the sink chains to. */
export const STATUSLINE_CHAIN_FILE = 'bodhilander-statusline.json';

/** JSON an editor saved with a byte-order mark, which JSON.parse refuses. */
export function parseJsonText(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

/** Identifies the statusLine command this app installed. */
export const STATUSLINE_SCRIPT_NAME = 'bodhilander-statusline.js';
