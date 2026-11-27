/**
 * Taint: a thread that read untrusted content is marked at once and durably,
 * so a run killed right after still counts. While tainted, a send or a shared
 * note write becomes a card; the thread's next run starts a fresh session.
 */
import type Database from 'better-sqlite3';
import { writeAudit } from './audit';

export const UNTRUSTED_OPEN = '<untrusted-content';
export const UNTRUSTED_CLOSE = '</untrusted-content>';

export function markTainted(db: Database.Database, hireId: string, threadKey: string, source: string): void {
  db.prepare(
    `INSERT INTO crew_taint (hire_id, thread_key, source) VALUES (?, ?, ?)
     ON CONFLICT(hire_id, thread_key) DO UPDATE SET source = excluded.source, tainted_at = CURRENT_TIMESTAMP`,
  ).run(hireId, threadKey, source);
  writeAudit(db, hireId, 'tainted', { threadKey, source });
}

export function isTainted(db: Database.Database, hireId: string, threadKey: string): boolean {
  return !!db.prepare(`SELECT 1 FROM crew_taint WHERE hire_id = ? AND thread_key = ?`).get(hireId, threadKey);
}

/** Called as the fresh session starts: true when the thread was tainted, and the mark is cleared. */
export function consumeTaint(db: Database.Database, hireId: string, threadKey: string): boolean {
  return db.prepare(`DELETE FROM crew_taint WHERE hire_id = ? AND thread_key = ?`).run(hireId, threadKey).changes > 0;
}

export type GatedAction = 'send' | 'shared-note-write';

/** What a tainted run may still do directly; everything gated goes to a card. */
export function gateFor(tainted: boolean, _action: GatedAction): 'direct' | 'card' {
  return tainted ? 'card' : 'direct';
}

/** Untrusted text in its wrapper. A closing marker inside it is defanged so the text cannot end its own wrapper. */
export function wrapUntrusted(source: string, text: string): string {
  const safeSource = source.replace(/[^\w.:/-]/g, '_');
  const body = text.replace(/<\/?untrusted-content/gi, (m) => m.replace('<', '&lt;'));
  return `${UNTRUSTED_OPEN} source="${safeSource}">\n${body}\n${UNTRUSTED_CLOSE}`;
}
