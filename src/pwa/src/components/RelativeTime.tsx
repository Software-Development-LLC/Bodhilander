/**
 * Self-updating "X seconds/minutes/hours ago" timestamp (BDHLNDR-59).
 *
 * Used by the stale-cache indicators in `SessionList` and `SessionDetail` —
 * the user is looking at cached data and we want them to know roughly how
 * stale it is. The component re-renders itself on an interval so the label
 * doesn't get stuck at "just now" for ten minutes.
 *
 * Tick cadence is adaptive: every 15s for the first minute, every minute
 * after that. Past an hour we tick every 15 minutes (the label rounds to
 * the hour anyway). This keeps the wakeups cheap on a backgrounded tab.
 */

import { useEffect, useState } from 'react';

export interface RelativeTimeProps {
  /** ms-epoch of the reference instant. */
  ts: number;
}

function formatRelative(deltaMs: number): string {
  const sec = Math.max(0, Math.floor(deltaMs / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function nextTickMs(deltaMs: number): number {
  if (deltaMs < 60_000) return 15_000;
  if (deltaMs < 3_600_000) return 60_000;
  return 15 * 60_000;
}

export function RelativeTime({ ts }: RelativeTimeProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const delta = now - ts;
    const handle = setTimeout(() => setNow(Date.now()), nextTickMs(delta));
    return () => clearTimeout(handle);
  }, [now, ts]);

  return <span>{formatRelative(now - ts)}</span>;
}
