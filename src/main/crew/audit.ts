import type Database from 'better-sqlite3';

/** One row in the local audit log. Detail is JSON; never put a token, URL or frame body in it. */
export function writeAudit(db: Database.Database, hireId: string | null, event: string, detail: Record<string, unknown> = {}): void {
  db.prepare('INSERT INTO crew_audit (hire_id, event, detail) VALUES (?, ?, ?)').run(hireId, event, JSON.stringify(detail));
}
