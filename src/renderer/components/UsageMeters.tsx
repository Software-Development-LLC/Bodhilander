import React from 'react';
import { AccountUsage, UsageUnavailableReason } from '../../shared/types';
import {
  currentPct,
  formatDuration,
  isUsageStale,
  UsageLevel,
  USAGE_WINDOWS,
  UsageWindowName,
} from '../../shared/usage';

export interface UsageMetersProps {
  usage: AccountUsage | null;
  /** Warning threshold, percent. */
  threshold: number;
  /** Epoch ms, passed in so a ticking parent re-renders the countdowns. */
  now: number;
}

const WINDOW_LABELS: Record<UsageWindowName, string> = { fiveHour: '5h', sevenDay: '7d' };

const UNAVAILABLE_TEXT: Record<UsageUnavailableReason, string> = {
  reauth: 'usage unavailable (re-auth needed)',
  error: 'usage unavailable',
  'no-credentials': 'usage unavailable (no token file for this account)',
  'no-keychain-credentials': 'usage unavailable (no Keychain sign-in for this account)',
};

function levelFor(pct: number, threshold: number): UsageLevel {
  if (pct >= 100) return 'critical';
  if (pct >= threshold) return 'warn';
  return 'ok';
}

function formatAge(ms: number): string {
  return ms < 60_000 ? 'just now' : `${formatDuration(ms)} ago`;
}

/** 5-hour and weekly meters for one account, with resets and the reading's age. */
export const UsageMeters: React.FC<UsageMetersProps> = ({ usage, threshold, now }) => {
  const windows = USAGE_WINDOWS.flatMap(name => {
    const window = usage?.[name] ?? null;
    const pct = currentPct(window, now);
    return window && pct !== null ? [{ name, pct, resetsAt: window.resetsAt }] : [];
  });
  const unavailable = usage?.unavailable ? UNAVAILABLE_TEXT[usage.unavailable] : null;

  if (windows.length === 0) {
    return (
      <div className="usage-meters usage-meters-empty">
        {unavailable ?? 'usage: no reading yet'}
      </div>
    );
  }

  const stale = isUsageStale(usage, now);
  return (
    <div className={`usage-meters${stale ? ' usage-meters-stale' : ''}`}>
      {windows.map(({ name, pct, resetsAt }) => {
        const shown = Math.round(pct);
        return (
          <div key={name} className={`usage-meter usage-${levelFor(pct, threshold)}`}>
            <span className="usage-meter-label">{WINDOW_LABELS[name]}</span>
            <span className="usage-meter-bar" aria-hidden="true">
              <span className="usage-meter-fill" style={{ width: `${Math.min(100, shown)}%` }} />
            </span>
            <span className="usage-meter-pct">{shown}%</span>
            {resetsAt !== null && resetsAt > now && (
              <span className="usage-meter-reset">resets in {formatDuration(resetsAt - now)}</span>
            )}
          </div>
        );
      })}
      <div className="usage-meta">
        {usage?.observedAt != null && <span>as of {formatAge(now - usage.observedAt)}</span>}
        {stale && <span className="usage-stale-tag">stale</span>}
        {unavailable && <span className="usage-unavailable">{unavailable}</span>}
      </div>
    </div>
  );
};

export default UsageMeters;
