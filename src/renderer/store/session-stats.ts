import { useState, useEffect, useCallback } from 'react';
import { SessionStats } from '../../shared/types';

interface UseSessionStatsResult {
  stats: SessionStats | null;
  loading: boolean;
}

export function useSessionStats(sessionId: string | null): UseSessionStatsResult {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [loading, setLoading] = useState(false);

  const loadStats = useCallback(async () => {
    if (!sessionId) {
      setStats(null);
      return;
    }
    try {
      setLoading(true);
      const result = await window.electronAPI.getSessionStats(sessionId);
      setStats(result);
    } catch {
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Refresh stats periodically while session is active (every 30s)
  useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(loadStats, 30000);
    return () => clearInterval(interval);
  }, [sessionId, loadStats]);

  return { stats, loading };
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 1) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatStatsTooltip(stats: SessionStats): string {
  const lines: string[] = [];
  if (stats.totalDurationSeconds > 0) {
    lines.push(`Duration: ${formatDuration(stats.totalDurationSeconds)}`);
  }
  lines.push(`Events: ${stats.totalEvents}`);
  const toolEntries = Object.entries(stats.toolUseCounts);
  if (toolEntries.length > 0) {
    const totalTools = toolEntries.reduce((sum, [, count]) => sum + count, 0);
    lines.push(`Tool calls: ${totalTools}`);
    for (const [name, count] of toolEntries.slice(0, 5)) {
      lines.push(`  ${name}: ${count}`);
    }
  }
  const stateEntries = Object.entries(stats.stateBreakdown);
  if (stateEntries.length > 0) {
    lines.push('Time breakdown:');
    for (const [state, secs] of stateEntries) {
      const dur = formatDuration(secs);
      if (dur) lines.push(`  ${state}: ${dur}`);
    }
  }
  return lines.join('\n');
}
