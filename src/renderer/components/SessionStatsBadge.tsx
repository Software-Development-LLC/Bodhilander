import React from 'react';
import { useSessionStats, formatDuration, formatStatsTooltip } from '../store/session-stats';

interface SessionStatsBadgeProps {
  sessionId: string;
}

/**
 * Compact stats badge for sidebar session entries (BDHLNDR-19).
 * Shows duration and event count in a single line below the session name.
 */
export function SessionStatsBadge({ sessionId }: SessionStatsBadgeProps) {
  const { stats } = useSessionStats(sessionId);

  if (!stats || stats.totalEvents === 0) return null;

  const duration = formatDuration(stats.totalDurationSeconds);
  const totalTools = Object.values(stats.toolUseCounts).reduce((sum, c) => sum + c, 0);

  const parts: string[] = [];
  if (duration) parts.push(duration);
  if (totalTools > 0) parts.push(`${totalTools} tools`);
  if (parts.length === 0) parts.push(`${stats.totalEvents} events`);

  return (
    <span
      className="session-stats-badge"
      title={formatStatsTooltip(stats)}
    >
      {parts.join(' · ')}
    </span>
  );
}
