/**
 * The desktop inbox's record of the cards this machine raised. Cards are decided in Teams at the
 * Hub; this only mirrors what was sent, whether the Hub took it, and the decision that came back.
 */
import type Database from 'better-sqlite3';
import type { CrewCard, CrewCardKind } from '../../shared/types';
import { writeAudit } from './audit';
import type { CardRaiseFrame } from './protocol';

type LogRow = {
  raise_id: string;
  hire_id: string;
  kind: CrewCardKind;
  summary: string;
  raised_at: number;
  acked: number;
  decision: 'approved' | 'denied' | null;
  decided_by: string | null;
  hire_data: string | null;
  card_state: string | null;
};

function summaryOf(frame: CardRaiseFrame): string {
  const p = frame.payload;
  if ('tool' in p) return p.summary || p.tool;
  if ('files' in p) return `${p.files.length} file${p.files.length === 1 ? '' : 's'}`;
  if ('path' in p) return p.path;
  return p.accountLabel;
}

export function recordCardRaise(db: Database.Database, frame: CardRaiseFrame, now: number): void {
  db.prepare(`INSERT OR IGNORE INTO crew_card_log (raise_id, hire_id, kind, summary, raised_at) VALUES (?, ?, ?, ?, ?)`).run(
    frame.id,
    frame.hireId,
    frame.kind,
    summaryOf(frame),
    now,
  );
}

export function markCardAcked(db: Database.Database, id: string): void {
  db.prepare(`UPDATE crew_card_log SET acked = 1 WHERE raise_id = ?`).run(id);
}

export function recordCardDecision(db: Database.Database, raiseId: string, decision: 'approved' | 'denied', decidedBy: string): void {
  db.prepare(`UPDATE crew_card_log SET acked = 1, decision = ?, decided_by = ? WHERE raise_id = ?`).run(decision, decidedBy, raiseId);
}

export function dropRefusedCard(db: Database.Database, raiseId: string, reason: string): void {
  const row = db.prepare(`SELECT hire_id FROM crew_card_log WHERE raise_id = ?`).get(raiseId) as { hire_id: string } | undefined;
  if (!row) return;
  db.prepare(`DELETE FROM crew_card_log WHERE raise_id = ?`).run(raiseId);
  writeAudit(db, row.hire_id, 'card-raise-refused', { raiseId, reason });
}

function hireName(data: string | null): string {
  try {
    const name = data ? (JSON.parse(data) as { name?: unknown }).name : undefined;
    return typeof name === 'string' ? name : 'Unknown hire';
  } catch {
    return 'Unknown hire';
  }
}

function stateOf(row: LogRow): NonNullable<CrewCard['state']> {
  if (row.decision !== null) return 'decided';
  if (!row.acked) return 'sending';
  return row.card_state === 'parked' ? 'parked' : 'waiting';
}

export function listCards(db: Database.Database): CrewCard[] {
  const rows = db
    .prepare(
      `SELECT l.*, h.data AS hire_data, c.state AS card_state FROM crew_card_log l
       LEFT JOIN crew_hire_cache h ON h.hire_id = l.hire_id
       LEFT JOIN crew_card c ON c.raise_id = l.raise_id
       ORDER BY l.raised_at DESC LIMIT 200`,
    )
    .all() as LogRow[];
  return rows.map((row) => ({
    raiseId: row.raise_id,
    hireId: row.hire_id,
    hireName: hireName(row.hire_data),
    kind: row.kind,
    summary: row.summary,
    raisedAt: row.raised_at,
    decision: row.decision,
    decidedBy: row.decided_by,
    state: stateOf(row),
  }));
}
