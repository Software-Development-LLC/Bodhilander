/**
 * A hire's notes on this machine. Writes go to the Hub as note_write; the
 * cache moves only on the Hub's answer. A run keeps the shared notes as they
 * were when it started, as the base of any note_patch card it raises.
 */
import type Database from 'better-sqlite3';
import type { EditResultFrame, NoteScope, NoteWriteFrame } from './protocol';

export const NOTE_MAX_CHARS = 100_000;

export interface NotePath {
  scope: NoteScope;
  rest: string;
}

/** `owner/<rest>` or `shared/<rest>`, with no empty, `.` or `..` segment and no backslash. */
export function parseNotePath(p: unknown): NotePath | null {
  if (typeof p !== 'string' || p.length > 300 || p.includes('\\') || p.includes('\0')) return null;
  const [scope, ...parts] = p.split('/');
  if (scope !== 'owner' && scope !== 'shared') return null;
  if (parts.length === 0 || parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  return { scope, rest: parts.join('/') };
}

export interface CachedNote {
  rev: number;
  content: string;
}

export function cachedNote(db: Database.Database, hireId: string, where: NotePath): CachedNote | null {
  const row = db.prepare(`SELECT rev, body FROM crew_note WHERE hire_id = ? AND scope = ? AND path = ?`).get(hireId, where.scope, where.rest) as
    | { rev: number; body: string }
    | undefined;
  return row ? { rev: row.rev, content: row.body } : null;
}

export function snapshotShared(db: Database.Database, hireId: string): Map<string, CachedNote> {
  const rows = db.prepare(`SELECT path, rev, body FROM crew_note WHERE hire_id = ? AND scope = 'shared'`).all(hireId) as { path: string; rev: number; body: string }[];
  return new Map(rows.map((r) => [r.path, { rev: r.rev, content: r.body }]));
}

/** An applied write lands in the cache at the Hub's rev, unless a newer copy already synced. */
export function applyNoteResult(db: Database.Database, sent: NoteWriteFrame, result: EditResultFrame): void {
  if (result.result !== 'applied' || !result.objectId || result.rev === undefined) return;
  const where = parseNotePath(sent.path);
  if (!where) return;
  const current = db.prepare(`SELECT rev FROM crew_note WHERE note_id = ?`).get(result.objectId) as { rev: number } | undefined;
  if (current && current.rev >= result.rev) return;
  if (sent.deleted) {
    db.prepare(`DELETE FROM crew_note WHERE note_id = ?`).run(result.objectId);
    return;
  }
  const data = JSON.stringify({ hireId: sent.hireId, scope: where.scope, path: where.rest, content: sent.content });
  db.prepare(
    `INSERT INTO crew_note (note_id, hire_id, scope, path, rev, body, data) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(note_id) DO UPDATE SET rev = excluded.rev, body = excluded.body, data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
  ).run(result.objectId, sent.hireId, where.scope, where.rest, result.rev, sent.content, data);
}
