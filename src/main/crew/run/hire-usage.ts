/**
 * A hire's tokens for the owner's day, as the per-hire cap counts them: the
 * Hub's total read at the day's first run (and again after a move), plus this
 * machine's runs since that read. With the Hub unreachable, local runs only.
 */
import type Database from 'better-sqlite3';
import { capDay, capTokens, dayStart } from '../holds';

export type HubUsageRead = (hireId: string, epoch: number, since: number) => Promise<number | null>;

interface Read {
  day: string;
  zone: string | null;
  epoch: number;
  total: number;
  readAt: number;
}

const sqlTime = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' ');

export function localTokensSince(db: Database.Database, hireId: string, since: number): number {
  const rows = db.prepare(`SELECT usage FROM crew_run WHERE hire_id = ? AND usage IS NOT NULL AND ended_at >= ?`).all(hireId, sqlTime(since)) as { usage: string }[];
  let total = 0;
  for (const row of rows) {
    try {
      total += capTokens(JSON.parse(row.usage) as Parameters<typeof capTokens>[0]);
    } catch {
      continue;
    }
  }
  return total;
}

export class HireDayUsage {
  private readonly reads = new Map<string, Read>();

  constructor(
    private readonly db: Database.Database,
    private readonly hub: HubUsageRead | null,
  ) {}

  async usedToday(hireId: string, epoch: number, now: number, timeZone: string | null): Promise<number> {
    const day = capDay(now, timeZone);
    const start = dayStart(now, timeZone);
    let read = this.reads.get(hireId);
    if (!read || read.day !== day || read.zone !== timeZone || read.epoch !== epoch) {
      this.reads.delete(hireId);
      read = undefined;
      const total = this.hub ? await this.hub(hireId, epoch, start).catch(() => null) : null;
      if (total !== null) {
        read = { day, zone: timeZone, epoch, total, readAt: now };
        this.reads.set(hireId, read);
      }
    }
    return read ? read.total + localTokensSince(this.db, hireId, read.readAt) : localTokensSince(this.db, hireId, start);
  }
}
