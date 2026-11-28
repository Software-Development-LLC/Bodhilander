/**
 * Usage read from a run's own stream: the start-of-run `rate_limit_event`
 * windows, and the run's tokens from `result.usage`. The session totals
 * (`total_cost_usd`, `modelUsage.*.costUSD`) grow across --resume and are never used.
 */
import type { UsageWindow } from '../../../shared/types';
import type { UsageObservation } from '../../usage-meter';

export interface RunUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

const WINDOW_KEYS: Record<string, 'fiveHour' | 'sevenDay'> = {
  five_hour: 'fiveHour',
  fiveHour: 'fiveHour',
  seven_day: 'sevenDay',
  sevenDay: 'sevenDay',
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function instant(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim() !== '') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function window(v: unknown, observedAt: number): UsageWindow | null {
  if (!isRecord(v) || typeof v.utilization !== 'number' || !Number.isFinite(v.utilization) || v.utilization < 0) return null;
  return { pct: Math.round(v.utilization * 100), resetsAt: instant(v.resetsAt ?? v.resets_at), observedAt };
}

/**
 * The windows one `rate_limit_event` reports, stamped with Crew's own observed-at
 * time. `unifiedWindows` is read keyed by window name or as a list naming each.
 * A window it does not report stays null: not reported, never 0%.
 */
function windowEntries(raw: unknown): [string, unknown][] {
  if (isRecord(raw)) return Object.entries(raw);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((w): [string, unknown][] => {
    const name = isRecord(w) ? (w.window ?? w.type ?? w.name) : undefined;
    return typeof name === 'string' ? [[name, w]] : [];
  });
}

export function parseRateLimitEvent(event: unknown, observedAt: number): UsageObservation | null {
  if (!isRecord(event) || event.type !== 'rate_limit_event') return null;
  const raw = event.unifiedWindows ?? (isRecord(event.rate_limit_info) ? event.rate_limit_info.unifiedWindows : undefined);
  const entries = windowEntries(raw);
  const obs: UsageObservation = { fiveHour: null, sevenDay: null, source: 'run', observedAt };
  for (const [name, value] of entries) {
    const key = WINDOW_KEYS[name];
    if (key) obs[key] = window(value, observedAt) ?? obs[key];
  }
  return obs.fiveHour || obs.sevenDay ? obs : null;
}

/** How long a hire is held when a rejection carries no reset time. */
export const REJECTED_RETRY_MS = 15 * 60_000;

function rejectedAt(info: unknown, now: number): number | null {
  if (!isRecord(info) || info.status !== 'rejected') return null;
  return instant(info.resetsAt ?? info.resets_at) ?? now + REJECTED_RETRY_MS;
}

/** When a usage-limit rejection the stream reports lifts: a rejected `rate_limit_event` or window, or the CLI's `quotaLimits` entry. */
export function parseRejection(event: unknown, now: number): number | null {
  if (!isRecord(event)) return null;
  if (event.type !== 'rate_limit_event') return rejectedAt(event.quotaLimits, now);
  const info = isRecord(event.rate_limit_info) ? event.rate_limit_info : event;
  const resets = [rejectedAt(info, now), ...windowEntries(info.unifiedWindows ?? event.unifiedWindows).map(([, w]) => rejectedAt(w, now))].filter((r): r is number => r !== null);
  return resets.length > 0 ? Math.max(...resets) : null;
}

/** The run's own tokens from `result.usage`; a missing count is 0. */
export function runUsage(result: unknown): RunUsage {
  const u = isRecord(result) && isRecord(result.usage) ? result.usage : {};
  const n = (k: string): number => {
    const v = u[k];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  };
  return {
    input_tokens: n('input_tokens'),
    cache_creation_input_tokens: n('cache_creation_input_tokens'),
    cache_read_input_tokens: n('cache_read_input_tokens'),
    output_tokens: n('output_tokens'),
  };
}
