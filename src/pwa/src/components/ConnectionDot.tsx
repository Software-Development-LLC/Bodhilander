/**
 * WebSocket connection status indicator (BDHLNDR-55 → shared in BDHLNDR-56).
 *
 * Tiny coloured dot mirroring `wsClient.status`:
 *   - connected      → green
 *   - connecting     → amber (pulsing)
 *   - reconnecting   → amber (pulsing)
 *   - idle / closed  → red
 *
 * Visual-only — the actual subscription lives in the parent page so a single
 * `useEffect(wsClient.onStatusChange)` powers both the dot and any other
 * status-aware UI (e.g. disabling the compose box while reconnecting if we
 * ever wanted to).
 */

import type { WsStatus } from '../lib/ws';

export function ConnectionDot({ status }: { status: WsStatus }) {
  const tone =
    status === 'connected'
      ? { color: 'bg-emerald-500', label: 'Connected' }
      : status === 'connecting' || status === 'reconnecting'
        ? { color: 'bg-amber-400 animate-pulse', label: 'Reconnecting' }
        : { color: 'bg-red-500', label: 'Disconnected' };
  return (
    <span
      role="status"
      aria-label={tone.label}
      title={tone.label}
      className={`inline-block h-2 w-2 rounded-full ${tone.color}`}
    />
  );
}
