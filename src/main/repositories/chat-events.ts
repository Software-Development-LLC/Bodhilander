/**
 * chat_events repository (BDHLNDR-51).
 *
 * Persists parser-emitted events from the PTY data stream so the mobile
 * companion (BDHLNDR-56) and the snapshot REST endpoint (BDHLNDR-58) can
 * replay recent chat history when a client connects mid-session.
 *
 * Per-session cap: the parser fires on every PTY chunk, so unbounded growth
 * is a real risk. createEvent() prunes to the most recent `keepCount` rows
 * (default 1000) for the affected session in the same transaction as the
 * insert — bounded storage, no background sweeper required.
 */

import { getDatabase } from '../database';
import type {
  ChatEvent,
  ChatEventType,
  PersistedChatEvent,
} from '../api/chat-parser/types';

interface ChatEventRow {
  id: string;
  session_id: string;
  type: string;
  payload: string;
  timestamp: number;
}

const DEFAULT_KEEP_COUNT = 1000;

function rowToEvent(row: ChatEventRow): PersistedChatEvent {
  let parsed: ChatEvent['payload'];
  try {
    parsed = JSON.parse(row.payload) as ChatEvent['payload'];
  } catch {
    // Corrupt JSON should never happen (we wrote it ourselves) but if it
    // does, surface a safe shape rather than throwing — the consumer can
    // skip the row.
    parsed = { text: '' } as ChatEvent['payload'];
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type as ChatEventType,
    payload: parsed,
    timestamp: row.timestamp,
  };
}

/**
 * Insert a chat event for a session. Prunes oldest rows beyond `keepCount`
 * for that session in the same transaction, keeping per-session storage
 * bounded.
 */
export function createEvent(
  sessionId: string,
  event: ChatEvent,
  options: { timestamp?: number; keepCount?: number } = {}
): PersistedChatEvent {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const timestamp = options.timestamp ?? Date.now();
  const keepCount = options.keepCount ?? DEFAULT_KEEP_COUNT;
  const payloadJson = JSON.stringify(event.payload);

  const insertStmt = db.prepare(`
    INSERT INTO chat_events (id, session_id, type, payload, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    insertStmt.run(id, sessionId, event.type, payloadJson, timestamp);
    pruneOldestForSession(sessionId, keepCount);
  });
  txn();

  return {
    id,
    sessionId,
    type: event.type,
    payload: event.payload,
    timestamp,
  };
}

/**
 * Fetch the most recent events for a session in ascending chronological
 * order (oldest → newest), so callers can render them directly as a chat
 * transcript. `sinceMs` (epoch ms) filters to events strictly newer than the
 * given timestamp — useful for incremental polling from the PWA.
 */
export function getEventsBySession(
  sessionId: string,
  sinceMs?: number,
  limit: number = 100
): PersistedChatEvent[] {
  const db = getDatabase();
  // Pull the most recent N rows (with optional `since` filter) DESC, then
  // re-sort ASC for the caller. This keeps the index-driven scan cheap even
  // when the table is large.
  let rows: ChatEventRow[];
  if (sinceMs !== undefined) {
    rows = db
      .prepare(
        'SELECT * FROM chat_events WHERE session_id = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT ?'
      )
      .all(sessionId, sinceMs, limit) as ChatEventRow[];
  } else {
    rows = db
      .prepare(
        'SELECT * FROM chat_events WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?'
      )
      .all(sessionId, limit) as ChatEventRow[];
  }
  return rows.map(rowToEvent).reverse();
}

/**
 * Trim a session's chat events to the most-recent `keepCount`. Called
 * automatically from createEvent; exported for direct use in maintenance
 * scripts or tests.
 */
export function pruneOldestForSession(
  sessionId: string,
  keepCount: number = DEFAULT_KEEP_COUNT
): number {
  const db = getDatabase();
  // Delete everything for the session that isn't in the top-N by timestamp.
  // Using a subquery on (id) lets the index on (session_id, timestamp) drive
  // both halves cheaply.
  const result = db
    .prepare(
      `DELETE FROM chat_events
       WHERE session_id = ?
         AND id NOT IN (
           SELECT id FROM chat_events
           WHERE session_id = ?
           ORDER BY timestamp DESC
           LIMIT ?
         )`
    )
    .run(sessionId, sessionId, keepCount);
  return result.changes;
}

/**
 * Hard-delete all chat events for a session — e.g. when the session itself
 * is deleted. Not wired up automatically yet (sessions table has no FK to
 * chat_events because we want chat history to outlive a session row in some
 * cases), but provided for explicit cleanup.
 */
export function deleteEventsForSession(sessionId: string): number {
  const db = getDatabase();
  const result = db
    .prepare('DELETE FROM chat_events WHERE session_id = ?')
    .run(sessionId);
  return result.changes;
}
