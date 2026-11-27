/**
 * Frames that need the Hub's answer wait here until it comes: `ack` deletes
 * the item, `refused` deletes it for good, and silence re-sends it. Items are
 * sent in seq order without waiting for each answer; the Hub reads them in order.
 */
import type Database from 'better-sqlite3';
import log from 'electron-log';
import { writeAudit } from './audit';
import type { EpochFence } from './epoch';
import { assertSendable } from './protocol-parse';
import { MACHINE_FRAME_TYPES, PROTOCOL_VERSION, type MachineFrame, type RefusedReason } from './protocol';

export const RESEND_FIRST_MS = 30_000;
export const RESEND_CAP_MS = 10 * 60_000;
export const PARK_AFTER = 10;

export type RefusalAction = 'sync' | 'drop-job' | 'dead-job' | 'fail-call' | 'none';

const ACTIONS: Record<RefusedReason, RefusalAction> = {
  'stale-epoch': 'sync',
  'not-home': 'sync',
  unknown: 'none',
  'wrong-hire': 'none',
  closed: 'drop-job',
  scope: 'fail-call',
  paused: 'fail-call',
  malformed: 'dead-job',
};

interface Row {
  seq: number;
  id: string;
  hire_id: string | null;
  epoch: number | null;
  job_id: string | null;
  frame_type: string;
  body: string;
  state: string;
  unanswered: number;
}

interface InFlight {
  /** This connection's send index when the item was last sent. */
  sentAt: number;
  sentMs: number;
  attempts: number;
  /** The Hub answered a frame sent after this one, so it read past it. */
  overtaken: boolean;
  /** A parked item gets one try per start or Send again, and no timed re-sends. */
  once: boolean;
}

export interface Sender {
  send(text: string): number;
}

export class LocalOutbox {
  private readonly inFlight = new Map<string, InFlight>();
  private retryParked = true;

  constructor(
    private readonly db: Database.Database,
    private readonly fence: EpochFence,
    private readonly random: () => number = Math.random,
  ) {}

  /** Throws on a frame over MAX_FRAME_BYTES, so the caller fails its tool call or job. */
  enqueue(frame: MachineFrame & { id: string }, meta: { hireId?: string; epoch?: number; jobId?: string } = {}): void {
    const body = assertSendable(frame);
    this.db
      .prepare(
        `INSERT INTO crew_outbox_local (id, hire_id, epoch, job_id, frame_type, protocol_version, body)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(frame.id, meta.hireId ?? null, meta.epoch ?? null, meta.jobId ?? null, frame.type, PROTOCOL_VERSION, body);
  }

  /** At start: rows this build no longer speaks are dropped and audited. */
  prune(): number {
    const rows = this.db.prepare(`SELECT seq, id, hire_id, frame_type, protocol_version FROM crew_outbox_local`).all() as {
      seq: number;
      id: string;
      hire_id: string | null;
      frame_type: string;
      protocol_version: number;
    }[];
    let dropped = 0;
    for (const row of rows) {
      const known = (MACHINE_FRAME_TYPES as readonly string[]).includes(row.frame_type);
      if (known && row.protocol_version === PROTOCOL_VERSION) continue;
      this.db.prepare('DELETE FROM crew_outbox_local WHERE seq = ?').run(row.seq);
      writeAudit(this.db, row.hire_id, 'outbox-dropped', { id: row.id, frameType: row.frame_type, version: row.protocol_version });
      dropped += 1;
    }
    return dropped;
  }

  private fenced(row: Row): boolean {
    if (row.hire_id === null || row.epoch === null) return false;
    const known = this.fence.known(row.hire_id);
    if (known !== null && row.epoch < known) {
      this.db.prepare(`UPDATE crew_outbox_local SET state = 'unsendable' WHERE seq = ?`).run(row.seq);
      return true;
    }
    return false;
  }

  private sendRow(row: Row, sender: Sender, now: number, once: boolean): void {
    const prior = this.inFlight.get(row.id);
    const sentAt = sender.send(row.body);
    this.inFlight.set(row.id, { sentAt, sentMs: now, attempts: (prior?.attempts ?? 0) + 1, overtaken: false, once });
  }

  /** On every welcome: every unanswered item, in its original order. */
  drain(sender: Sender, now: number): number {
    const states = this.retryParked ? `('pending', 'parked')` : `('pending')`;
    this.retryParked = false;
    const rows = this.db.prepare(`SELECT * FROM crew_outbox_local WHERE state IN ${states} ORDER BY seq`).all() as Row[];
    let sent = 0;
    for (const row of rows) {
      if (this.fenced(row)) continue;
      this.sendRow(row, sender, now, row.state === 'parked');
      sent += 1;
    }
    return sent;
  }

  /** Send an item enqueued while connected. */
  sendNow(id: string, sender: Sender, now: number): boolean {
    const row = this.db.prepare(`SELECT * FROM crew_outbox_local WHERE id = ? AND state = 'pending'`).get(id) as Row | undefined;
    if (!row || this.fenced(row)) return false;
    this.sendRow(row, sender, now, false);
    return true;
  }

  /** Send again, from the hire page: one try for a parked item. */
  sendAgain(id: string, sender: Sender, now: number): boolean {
    const row = this.db.prepare(`SELECT * FROM crew_outbox_local WHERE id = ? AND state = 'parked'`).get(id) as Row | undefined;
    if (!row || this.fenced(row)) return false;
    this.sendRow(row, sender, now, true);
    return true;
  }

  private delay(attempts: number): number {
    const base = Math.min(RESEND_FIRST_MS * 2 ** Math.max(0, attempts - 1), RESEND_CAP_MS);
    return base - base * 0.2 * this.random();
  }

  /** Timed re-sends. An overtaken item counts one unanswered re-send; ten park it. */
  tick(sender: Sender, now: number): void {
    const rows = this.db.prepare(`SELECT * FROM crew_outbox_local WHERE state = 'pending' ORDER BY seq`).all() as Row[];
    for (const row of rows) {
      const flight = this.inFlight.get(row.id);
      if (!flight || flight.once) continue;
      if (now - flight.sentMs < this.delay(flight.attempts)) continue;
      if (this.fenced(row)) {
        this.inFlight.delete(row.id);
        continue;
      }
      if (flight.overtaken) {
        const unanswered = row.unanswered + 1;
        if (unanswered >= PARK_AFTER) {
          this.db.prepare(`UPDATE crew_outbox_local SET state = 'parked', unanswered = ? WHERE seq = ?`).run(unanswered, row.seq);
          writeAudit(this.db, row.hire_id, 'outbox-parked', { id: row.id, frameType: row.frame_type });
          this.inFlight.delete(row.id);
          continue;
        }
        this.db.prepare(`UPDATE crew_outbox_local SET unanswered = ? WHERE seq = ?`).run(unanswered, row.seq);
      }
      this.sendRow(row, sender, now, false);
    }
  }

  /** The Hub answered the frame sent at `sentAt`; every item sent before it was read. */
  noteAnswered(sentAt: number): void {
    for (const flight of this.inFlight.values()) {
      if (flight.sentAt < sentAt) flight.overtaken = true;
    }
  }

  /** The send index of an in-flight item, so its answer can overtake the ones before it. */
  sentIndex(id: string): number | null {
    return this.inFlight.get(id)?.sentAt ?? null;
  }

  onAck(id: string): boolean {
    const sentAt = this.sentIndex(id);
    if (sentAt !== null) this.noteAnswered(sentAt);
    this.inFlight.delete(id);
    return this.db.prepare('DELETE FROM crew_outbox_local WHERE id = ?').run(id).changes > 0;
  }

  /** A refusal is final. Returns null when no item has that id. */
  onRefused(id: string, reason: string): { action: RefusalAction; hireId: string | null; jobId: string | null } | null {
    const row = this.db.prepare('SELECT * FROM crew_outbox_local WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const sentAt = this.sentIndex(id);
    if (sentAt !== null) this.noteAnswered(sentAt);
    this.inFlight.delete(id);
    const action: RefusalAction = (ACTIONS as Record<string, RefusalAction>)[reason] ?? 'none';
    if (!(reason in ACTIONS)) log.warn(`[Crew] refused ${row.frame_type} ${id} with an unknown reason`);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM crew_outbox_local WHERE seq = ?').run(row.seq);
      writeAudit(this.db, row.hire_id, 'refused', { id, frameType: row.frame_type, reason });
      if (row.job_id && action === 'drop-job') {
        this.db.prepare(`UPDATE crew_job SET state = 'dropped', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.job_id);
      }
      if (row.job_id && action === 'dead-job') {
        this.db.prepare(`UPDATE crew_job SET state = 'dead', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.job_id);
      }
    })();
    return { action, hireId: row.hire_id, jobId: row.job_id };
  }

  onConnectionClosed(): void {
    this.inFlight.clear();
  }

  /** Unlinked: nothing in the outbox is ever sent again. */
  dropAll(): void {
    this.inFlight.clear();
    this.db.prepare(`UPDATE crew_outbox_local SET state = 'unsendable'`).run();
  }

  parkedCount(hireId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM crew_outbox_local WHERE hire_id = ? AND state = 'parked'`).get(hireId) as {
      n: number;
    };
    return row.n;
  }
}
