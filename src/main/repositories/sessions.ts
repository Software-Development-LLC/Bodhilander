import { getDatabase } from '../database';
import { Session, SessionState } from '../../shared/types';

export function getAllSessions(): Session[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM sessions ORDER BY "order"').all() as any[];

  return rows.map(row => ({
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    workingDir: row.working_dir,
    state: row.state as SessionState,
    shellType: row.shell_type,
    order: row.order,
    createdAt: new Date(row.created_at),
    lastActivityAt: new Date(row.last_activity_at),
    claudeSessionId: row.claude_session_id ?? null,
    endedAt: row.ended_at ? new Date(row.ended_at) : null,
    durationSeconds: row.duration_seconds ?? 0,
  }));
}

export function createSession(session: Session): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO sessions (id, group_id, name, working_dir, state, shell_type, "order", created_at, last_activity_at, claude_session_id, ended_at, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    session.groupId,
    session.name,
    session.workingDir,
    session.state,
    session.shellType,
    session.order,
    session.createdAt.toISOString(),
    session.lastActivityAt.toISOString(),
    session.claudeSessionId ?? null,
    session.endedAt ? session.endedAt.toISOString() : null,
    session.durationSeconds ?? 0
  );
}

/**
 * Get the stored Claude session UUID for a Bodhilander session (BDHLNDR-9).
 * Returns null if no Claude session has been launched yet for this session.
 */
export function getClaudeSessionId(id: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT claude_session_id FROM sessions WHERE id = ?').get(id) as
    | { claude_session_id: string | null }
    | undefined;
  return row?.claude_session_id ?? null;
}

/**
 * Store the Claude session UUID so we can pass it to `claude --resume` on restart (BDHLNDR-9).
 */
export function setClaudeSessionId(id: string, claudeSessionId: string): void {
  const db = getDatabase();
  db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run(claudeSessionId, id);
}

/**
 * Clear the stored Claude session UUID (e.g. after a failed resume) so the next
 * launch starts fresh (BDHLNDR-9).
 */
export function clearClaudeSessionId(id: string): void {
  const db = getDatabase();
  db.prepare('UPDATE sessions SET claude_session_id = NULL WHERE id = ?').run(id);
}

export function updateSession(id: string, updates: Partial<Session>): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.groupId !== undefined) {
    fields.push('group_id = ?');
    values.push(updates.groupId);
  }
  if (updates.state !== undefined) {
    fields.push('state = ?');
    values.push(updates.state);
  }
  if (updates.order !== undefined) {
    fields.push('"order" = ?');
    values.push(updates.order);
  }
  if (updates.lastActivityAt !== undefined) {
    fields.push('last_activity_at = ?');
    values.push(updates.lastActivityAt.toISOString());
  }
  if (updates.endedAt !== undefined) {
    fields.push('ended_at = ?');
    values.push(updates.endedAt ? updates.endedAt.toISOString() : null);
  }
  if (updates.durationSeconds !== undefined) {
    fields.push('duration_seconds = ?');
    values.push(updates.durationSeconds);
  }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
}

export function deleteSession(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function clearAllSessions(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM sessions').run();
}

export function markAllSessionsStopped(): void {
  const db = getDatabase();
  db.prepare("UPDATE sessions SET state = 'stopped'").run();
}
