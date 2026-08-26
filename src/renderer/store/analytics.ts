import { useState, useEffect, useCallback } from 'react';
import { GlobalStats, SessionEvent } from '../../shared/types';

export type TimeRange = 'today' | '7d' | '30d' | 'all';

function timeRangeToSince(range: TimeRange): string | undefined {
  if (range === 'all') return undefined;
  const now = new Date();
  switch (range) {
    case 'today':
      now.setHours(0, 0, 0, 0);
      return now.toISOString();
    case '7d':
      now.setDate(now.getDate() - 7);
      return now.toISOString();
    case '30d':
      now.setDate(now.getDate() - 30);
      return now.toISOString();
  }
}

interface UseAnalyticsResult {
  globalStats: GlobalStats | null;
  recentEvents: SessionEvent[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useAnalytics(timeRange: TimeRange): UseAnalyticsResult {
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [recentEvents, setRecentEvents] = useState<SessionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const since = timeRangeToSince(timeRange);
      const stats = await window.electronAPI.getGlobalStats(since);
      setGlobalStats(stats);

      // Load recent events (last 30 across all sessions)
      const allSessions = await window.electronAPI.getAllSessions();
      const allEvents: SessionEvent[] = [];
      // Fetch last few events per session, then sort globally
      for (const session of allSessions.slice(0, 20)) {
        const events = await window.electronAPI.getSessionEvents(session.id, 10);
        allEvents.push(...events);
      }
      allEvents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setRecentEvents(allEvents.slice(0, 30));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  return { globalStats, recentEvents, loading, error, refresh: () => { void loadStats(); } };
}
