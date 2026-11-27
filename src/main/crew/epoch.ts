/**
 * The epoch fence on the machine side. Every job keeps the epoch it was
 * delivered under, and every frame sent for it carries that epoch. Learning a
 * newer epoch for a hire drops its older jobs and stops its older outbox items.
 */
import type Database from 'better-sqlite3';
import type { DeliverFrame } from './protocol';

export type DeliveryOutcome = 'stored' | 'duplicate' | 'stale';

export class EpochFence {
  constructor(private readonly db: Database.Database) {}

  /** The newest epoch this machine knows for the hire, from sync or from any job. */
  known(hireId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(e) AS e FROM (
           SELECT epoch AS e FROM crew_hire_cache WHERE hire_id = ?
           UNION ALL SELECT MAX(epoch) FROM crew_job WHERE hire_id = ?
         )`,
      )
      .get(hireId, hireId) as { e: number | null } | undefined;
    return row?.e ?? null;
  }

  /** Record a newer epoch for the hire; returns true when it was newer. */
  observe(hireId: string, epoch: number): boolean {
    const current = this.known(hireId);
    if (current !== null && epoch <= current) return false;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO crew_hire_cache (hire_id, epoch) VALUES (?, ?)
           ON CONFLICT(hire_id) DO UPDATE SET epoch = excluded.epoch, updated_at = CURRENT_TIMESTAMP`,
        )
        .run(hireId, epoch);
      this.fenceBelow(hireId, epoch);
    })();
    return true;
  }

  private fenceBelow(hireId: string, epoch: number): void {
    this.db
      .prepare(
        `UPDATE crew_job SET state = 'dropped', updated_at = CURRENT_TIMESTAMP
         WHERE hire_id = ? AND epoch < ? AND state IN ('queued', 'running', 'parked')`,
      )
      .run(hireId, epoch);
    this.db
      .prepare(`UPDATE crew_outbox_local SET state = 'unsendable' WHERE hire_id = ? AND epoch < ? AND state != 'unsendable'`)
      .run(hireId, epoch);
  }

  /** A drop revoke or an unlink: every job for the hire, at any epoch, and nothing more is sent. */
  dropHire(hireId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE crew_job SET state = 'dropped', updated_at = CURRENT_TIMESTAMP
           WHERE hire_id = ? AND state IN ('queued', 'running', 'parked')`,
        )
        .run(hireId);
      this.db.prepare(`UPDATE crew_outbox_local SET state = 'unsendable' WHERE hire_id = ?`).run(hireId);
    })();
  }

  /** An interrupted run's job waits for the next renewal. */
  requeueRunning(hireId: string): void {
    this.db
      .prepare(`UPDATE crew_job SET state = 'queued', updated_at = CURRENT_TIMESTAMP WHERE hire_id = ? AND state = 'running'`)
      .run(hireId);
  }

  /** The epoch to stamp on a lease_revoked: the latest job's, else the synced one, else 0. */
  revokeEpoch(hireId: string): number {
    const job = this.db
      .prepare(`SELECT epoch FROM crew_job WHERE hire_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(hireId) as { epoch: number } | undefined;
    if (job) return job.epoch;
    const hire = this.db.prepare(`SELECT epoch FROM crew_hire_cache WHERE hire_id = ?`).get(hireId) as
      | { epoch: number }
      | undefined;
    return hire?.epoch ?? 0;
  }

  /** Store a delivery under its epoch. Older than known is kept as dropped; newer fences the rest. */
  recordDelivery(frame: DeliverFrame): DeliveryOutcome {
    return this.db.transaction((): DeliveryOutcome => {
      const current = this.known(frame.hireId);
      if (current !== null && frame.epoch > current) this.observe(frame.hireId, frame.epoch);
      const stale = current !== null && frame.epoch < current;
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO crew_job (id, hire_id, kind, epoch, scope, requested_by, sender, text, state)
           VALUES (?, ?, 'message', ?, ?, ?, ?, ?, ?)`,
        )
        .run(frame.id, frame.hireId, frame.epoch, frame.scope, frame.requestedBy, frame.from, frame.text, stale ? 'dropped' : 'queued');
      if (result.changes === 0) return 'duplicate';
      return stale ? 'stale' : 'stored';
    })();
  }

  /** The epoch a frame about this job is stamped with, or null when the job is gone or fenced. */
  stampFor(jobId: string): { hireId: string; epoch: number } | null {
    const job = this.db.prepare(`SELECT hire_id, epoch, state FROM crew_job WHERE id = ?`).get(jobId) as
      | { hire_id: string; epoch: number; state: string }
      | undefined;
    if (!job || job.state === 'dropped') return null;
    const current = this.known(job.hire_id);
    if (current !== null && job.epoch < current) return null;
    return { hireId: job.hire_id, epoch: job.epoch };
  }
}
