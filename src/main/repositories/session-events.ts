import { getDatabase } from '../database';
import { SessionEvent, SessionEventType, SessionStats, GlobalStats } from '../../shared/types';

interface SessionEventRow {
  id: string;
  session_id: string;
  event_type: string;
  event_data: string | null;
  created_at: string;
}

function safeJsonParse(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function rowToSessionEvent(row: SessionEventRow): SessionEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type as SessionEventType,
    eventData: safeJsonParse(row.event_data),
    createdAt: new Date(row.created_at),
  };
}

export function createEvent(
  sessionId: string,
  eventType: SessionEventType,
  eventData?: Record<string, unknown> | null
): SessionEvent {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const data = eventData ? JSON.stringify(eventData) : null;

  db.prepare(`
    INSERT INTO session_events (id, session_id, event_type, event_data, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, sessionId, eventType, data, now);

  return {
    id,
    sessionId,
    eventType,
    eventData: eventData ?? null,
    createdAt: new Date(now),
  };
}

export function getEventsBySession(sessionId: string, limit: number = 500): SessionEvent[] {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM session_events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(sessionId, limit) as SessionEventRow[];
  return rows.map(rowToSessionEvent);
}

export function getEventsByType(eventType: SessionEventType, limit: number = 500): SessionEvent[] {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM session_events WHERE event_type = ? ORDER BY created_at DESC LIMIT ?'
  ).all(eventType, limit) as SessionEventRow[];
  return rows.map(rowToSessionEvent);
}

export function getEventsSince(since: Date, sessionId?: string, limit: number = 10000): SessionEvent[] {
  const db = getDatabase();
  const sinceStr = since.toISOString();
  let rows: SessionEventRow[];

  if (sessionId) {
    rows = db.prepare(
      'SELECT * FROM session_events WHERE created_at >= ? AND session_id = ? ORDER BY created_at ASC LIMIT ?'
    ).all(sinceStr, sessionId, limit) as SessionEventRow[];
  } else {
    rows = db.prepare(
      'SELECT * FROM session_events WHERE created_at >= ? ORDER BY created_at ASC LIMIT ?'
    ).all(sinceStr, limit) as SessionEventRow[];
  }

  return rows.map(rowToSessionEvent);
}

export function getLastEvent(sessionId: string): SessionEvent | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM session_events WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(sessionId) as SessionEventRow | undefined;
  return row ? rowToSessionEvent(row) : null;
}

export function getToolUseCounts(sessionId?: string): Record<string, number> {
  const db = getDatabase();
  let rows: { tool: string; count: number }[];

  if (sessionId) {
    rows = db.prepare(`
      SELECT json_extract(event_data, '$.tool_name') as tool, COUNT(*) as count
      FROM session_events
      WHERE event_type = 'tool_use' AND session_id = ?
      GROUP BY tool
      ORDER BY count DESC
    `).all(sessionId) as { tool: string; count: number }[];
  } else {
    rows = db.prepare(`
      SELECT json_extract(event_data, '$.tool_name') as tool, COUNT(*) as count
      FROM session_events
      WHERE event_type = 'tool_use'
      GROUP BY tool
      ORDER BY count DESC
    `).all() as { tool: string; count: number }[];
  }

  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.tool) {
      counts[row.tool] = row.count;
    }
  }
  return counts;
}

export function getStateBreakdown(sessionId: string): Record<string, number> {
  const db = getDatabase();

  // Get all state-related events in chronological order
  const rows = db.prepare(`
    SELECT event_type, event_data, created_at
    FROM session_events
    WHERE session_id = ? AND event_type IN ('state_change', 'session_start', 'session_stop')
    ORDER BY created_at ASC
  `).all(sessionId) as { event_type: string; event_data: string | null; created_at: string }[];

  const breakdown: Record<string, number> = {};

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.event_type !== 'state_change' || !row.event_data) continue;

    const data = safeJsonParse(row.event_data);
    if (!data?.to) continue;

    const toState = data.to as string;
    const currentTime = new Date(row.created_at).getTime();

    // Use next event's time as boundary, or current time for open-ended final interval
    const nextRow = rows[i + 1];
    const nextTime = nextRow ? new Date(nextRow.created_at).getTime() : Date.now();
    const seconds = (nextTime - currentTime) / 1000;

    breakdown[toState] = (breakdown[toState] || 0) + seconds;
  }

  return breakdown;
}

export function getSessionStats(sessionId: string): SessionStats {
  const db = getDatabase();

  const countRow = db.prepare(
    'SELECT COUNT(*) as count FROM session_events WHERE session_id = ?'
  ).get(sessionId) as { count: number };

  const durationRow = db.prepare(
    'SELECT duration_seconds FROM sessions WHERE id = ?'
  ).get(sessionId) as { duration_seconds: number } | undefined;

  return {
    totalEvents: countRow.count,
    totalDurationSeconds: durationRow?.duration_seconds ?? 0,
    toolUseCounts: getToolUseCounts(sessionId),
    stateBreakdown: getStateBreakdown(sessionId),
  };
}

export function getGlobalStats(since?: Date): GlobalStats {
  const db = getDatabase();
  const sinceStr = since?.toISOString();

  // Total sessions
  let totalSessions: number;
  if (sinceStr) {
    totalSessions = (db.prepare(
      'SELECT COUNT(DISTINCT session_id) as count FROM session_events WHERE created_at >= ?'
    ).get(sinceStr) as { count: number }).count;
  } else {
    totalSessions = (db.prepare(
      'SELECT COUNT(DISTINCT session_id) as count FROM session_events'
    ).get() as { count: number }).count;
  }

  // Total events
  let totalEvents: number;
  if (sinceStr) {
    totalEvents = (db.prepare(
      'SELECT COUNT(*) as count FROM session_events WHERE created_at >= ?'
    ).get(sinceStr) as { count: number }).count;
  } else {
    totalEvents = (db.prepare(
      'SELECT COUNT(*) as count FROM session_events'
    ).get() as { count: number }).count;
  }

  // Total duration
  let totalDurationSeconds: number;
  if (sinceStr) {
    totalDurationSeconds = (db.prepare(
      'SELECT COALESCE(SUM(duration_seconds), 0) as total FROM sessions WHERE created_at >= ?'
    ).get(sinceStr) as { total: number }).total;
  } else {
    totalDurationSeconds = (db.prepare(
      'SELECT COALESCE(SUM(duration_seconds), 0) as total FROM sessions'
    ).get() as { total: number }).total;
  }

  // Events per day
  let eventsPerDay: { date: string; count: number }[];
  if (sinceStr) {
    eventsPerDay = db.prepare(`
      SELECT date(created_at) as date, COUNT(*) as count
      FROM session_events
      WHERE created_at >= ?
      GROUP BY date(created_at)
      ORDER BY date ASC
    `).all(sinceStr) as { date: string; count: number }[];
  } else {
    eventsPerDay = db.prepare(`
      SELECT date(created_at) as date, COUNT(*) as count
      FROM session_events
      GROUP BY date(created_at)
      ORDER BY date ASC
    `).all() as { date: string; count: number }[];
  }

  return {
    totalSessions,
    totalEvents,
    totalDurationSeconds,
    eventsPerDay,
    toolUseCounts: getToolUseCounts(),
  };
}

export function pruneEvents(olderThan: Date): number {
  const db = getDatabase();
  const result = db.prepare(
    'DELETE FROM session_events WHERE created_at < ?'
  ).run(olderThan.toISOString());
  return result.changes;
}
