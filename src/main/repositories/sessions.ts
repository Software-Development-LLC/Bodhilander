import { getDatabase } from '../database';
import { Session, SessionState } from '../../shared/types';

export function sessionExists(id: string): boolean {
  const db = getDatabase();
  const row = db.prepare('SELECT 1 FROM sessions WHERE id = ? LIMIT 1').get(id);
  return !!row;
}

/** sessions row → domain object. Shared so a single-row lookup and the full
 *  listing cannot drift in how they read the same columns. */
function mapSessionRow(row: any): Session {
  return {
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
    claudeAccountId: row.claude_account_id ?? null,
    provider: row.provider ?? 'claude',
    failoverFromAccountId: row.failover_from_account_id ?? null,
    failoverPrevAccountId: row.failover_prev_account_id ?? null,
  };
}

export function getAllSessions(): Session[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM sessions ORDER BY "order", created_at IS NULL, created_at, id').all() as any[];
  return rows.map(mapSessionRow);
}

/**
 * One session by id, or null.
 *
 * Hits the primary key rather than loading the table and filtering: the
 * failover and fail-back sweeps call this per session, on the main process,
 * and "there are only tens of rows" is a reason it wasn't slow, not a reason
 * for the query to say something other than what it means.
 */
export function getSession(id: string): Session | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return row ? mapSessionRow(row) : null;
}

export function createSession(session: Session): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO sessions (id, group_id, name, working_dir, state, shell_type, "order", created_at, last_activity_at, claude_session_id, ended_at, duration_seconds, claude_account_id, provider, failover_from_account_id, failover_prev_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    session.durationSeconds ?? 0,
    session.claudeAccountId ?? null,
    session.provider ?? 'claude',
    session.failoverFromAccountId ?? null,
    session.failoverPrevAccountId ?? null
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
  if (updates.claudeAccountId !== undefined) {
    fields.push('claude_account_id = ?');
    values.push(updates.claudeAccountId);
  }
  if (updates.failoverFromAccountId !== undefined) {
    fields.push('failover_from_account_id = ?');
    values.push(updates.failoverFromAccountId);
  }
  if (updates.failoverPrevAccountId !== undefined) {
    fields.push('failover_prev_account_id = ?');
    values.push(updates.failoverPrevAccountId);
  }
  if (updates.provider !== undefined) {
    // Changing provider invalidates any stored conversation UUID — it belongs
    // to the previous provider's CLI and must never be replayed as another
    // provider's resume flag (#96). SET expressions evaluate against the
    // pre-update row, so `provider` here is the old value.
    fields.push('claude_session_id = CASE WHEN provider IS ? THEN claude_session_id ELSE NULL END');
    values.push(updates.provider);
    fields.push('provider = ?');
    values.push(updates.provider);
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
