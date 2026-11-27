/**
 * Fires a home machine's routines on its own clock, in each routine's zone.
 * Missed firings since the Hub's lastFired coalesce into one late run, which
 * is skipped when the next firing is near. A skewed clock holds every routine.
 */
import type Database from 'better-sqlite3';
import { writeAudit } from '../audit';
import { derivedUuid } from '../hub-client';
import { cronMatchesDay, parseCron, type Cron } from './cron';
import { addDays, isZone, zonedDate, zonedTime, zonedToUtc } from './zoned';

export const LATE_AFTER_MS = 2 * 60_000;
export const SKIP_WITHIN_MS = 15 * 60_000;
export const SCHEDULE_TICK_MS = 30_000;
const SEARCH_DAYS = 366;

export interface SchedulerHub {
  routinesHeldForSkew(): boolean;
  clockSkewMs(): number;
  canStart(hireId: string, epoch: number): boolean;
  knownEpoch(hireId: string): number | null;
  sendRoutineFired(jobId: string, routineId: string, dueAt: number, startedAt: number): boolean;
}

export interface SchedulerDeps {
  db: Database.Database;
  hub: SchedulerHub;
  machineId(): string | null;
  tellOwner(text: string): void;
  /** A routine job was queued. */
  queued?(): void;
  now?(): number;
}

export interface Fired {
  routineId: string;
  jobId: string;
  dueAt: number;
  late: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

function occurrencesOn(cron: Cron, tz: string, date: string): Date[] {
  if (!cronMatchesDay(cron, date)) return [];
  const out = new Map<number, Date>();
  for (const h of cron.hours) for (const m of cron.minutes) {
    const at = zonedToUtc(date, `${pad(h)}:${pad(m)}`, tz);
    out.set(at.getTime(), at);
  }
  return [...out.values()].sort((a, b) => a.getTime() - b.getTime());
}

/** The latest occurrence in (after, upTo], or null. */
export function latestOccurrence(cron: Cron, tz: string, after: Date | null, upTo: Date): Date | null {
  const last = zonedDate(upTo, tz);
  const first = after ? addDays(zonedDate(after, tz), -1) : addDays(last, -1);
  for (let date = last, i = 0; date >= first && i <= SEARCH_DAYS; date = addDays(date, -1), i++) {
    const hit = occurrencesOn(cron, tz, date)
      .reverse()
      .find((at) => at <= upTo && (!after || at > after));
    if (hit) return hit;
  }
  return null;
}

/** The first occurrence after `after` within a year, or null. */
export function nextOccurrence(cron: Cron, tz: string, after: Date): Date | null {
  const start = zonedDate(after, tz);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const hit = occurrencesOn(cron, tz, addDays(start, i)).find((at) => at > after);
    if (hit) return hit;
  }
  return null;
}

/** The hire owner's person id: the Hub sets it on owner-scope deliveries. */
export function ownerPersonId(db: Database.Database, hireId: string): string | null {
  const hire = db.prepare(`SELECT data FROM crew_hire_cache WHERE hire_id = ?`).get(hireId) as { data: string } | undefined;
  const owner = parse(hire?.data).ownerId;
  if (typeof owner === 'string' && owner) return owner;
  const row = db
    .prepare(`SELECT requested_by FROM crew_job WHERE hire_id = ? AND kind = 'message' AND scope = 'owner' ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(hireId) as { requested_by: string } | undefined;
  return row?.requested_by || null;
}

function parse(data: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(data ?? '{}') as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const NOT_RUNNING = /^(provisioning|paused|let_go|held:no-home)/;

function skewText(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  const span = minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`;
  return `This machine's clock is ${span} off the Crew Hub's, so routines are held until it is within 2 minutes. Messages still run.`;
}

type Row = { routine_id: string; hire_id: string; last_fired: string | null; data: string; hire_home: string | null; hire_data: string };

export class RoutineScheduler {
  private toldSkew = false;
  private readonly complained = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private complainOnce(key: string, hireId: string, event: string, detail: Record<string, unknown>): void {
    if (this.complained.has(key)) return;
    this.complained.add(key);
    writeAudit(this.deps.db, hireId, event, detail);
  }

  tick(): Fired[] {
    const { db, hub } = this.deps;
    if (hub.routinesHeldForSkew()) {
      if (!this.toldSkew) {
        this.toldSkew = true;
        writeAudit(db, null, 'routines-held-skew', { skewMs: hub.clockSkewMs() });
        this.deps.tellOwner(skewText(hub.clockSkewMs()));
      }
      return [];
    }
    if (this.toldSkew) writeAudit(db, null, 'routines-resumed', {});
    this.toldSkew = false;
    const mine = this.deps.machineId();
    if (!mine) return [];
    const rows = db
      .prepare(
        `SELECT r.routine_id, r.hire_id, r.last_fired, r.data, h.home_machine_id AS hire_home, h.data AS hire_data
         FROM crew_routine_cache r JOIN crew_hire_cache h ON h.hire_id = r.hire_id ORDER BY r.routine_id`,
      )
      .all() as Row[];
    const now = this.now();
    const fired: Fired[] = [];
    for (const row of rows) {
      const one = this.consider(row, mine, now);
      if (one) fired.push(one);
    }
    if (fired.length > 0) this.deps.queued?.();
    return fired;
  }

  private consider(row: Row, mine: string, now: number): Fired | null {
    const hire = parse(row.hire_data);
    const home = typeof hire.homeMachineId === 'string' ? hire.homeMachineId : row.hire_home;
    if (home !== mine) return null;
    if (typeof hire.state === 'string' && NOT_RUNNING.test(hire.state)) return null;
    const body = parse(row.data);
    const cronText = typeof body.cron === 'string' ? body.cron : '';
    const tz = typeof body.timezone === 'string' ? body.timezone : '';
    let cron: Cron;
    try {
      cron = parseCron(cronText);
      if (!isZone(tz)) throw new Error(`${tz} is not a time zone`);
    } catch (err) {
      this.complainOnce(`${row.routine_id}:${cronText}:${tz}`, row.hire_id, 'routine-unreadable', { routineId: row.routine_id, why: String(err) });
      return null;
    }
    const epoch = this.deps.hub.knownEpoch(row.hire_id) ?? (typeof hire.epoch === 'number' ? hire.epoch : 0);
    if (!this.deps.hub.canStart(row.hire_id, epoch)) return null;

    const fromBody = typeof body.lastFired === 'number' ? body.lastFired : null;
    const fromColumn = row.last_fired === null ? null : Number(row.last_fired);
    const known = [fromBody, fromColumn].filter((v): v is number => v !== null && Number.isFinite(v));
    const lastFired = known.length > 0 ? Math.max(...known) : null;
    const due = latestOccurrence(cron, tz, lastFired === null ? null : new Date(lastFired), new Date(now));
    if (!due) return null;
    const late = now - due.getTime() >= LATE_AFTER_MS;
    if (late && lastFired === null) return null;
    if (late) {
      const next = nextOccurrence(cron, tz, new Date(now));
      if (next && next.getTime() - now <= SKIP_WITHIN_MS) return null;
    }

    const requestedBy = ownerPersonId(this.deps.db, row.hire_id);
    if (!requestedBy) {
      this.complainOnce(`${row.routine_id}:owner`, row.hire_id, 'routine-no-owner', { routineId: row.routine_id });
      return null;
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const text = late ? `${prompt}\n\nThis was due at ${zonedTime(due, tz)} and is running at ${zonedTime(new Date(now), tz)}.` : prompt;
    const dueAt = due.getTime();
    const jobId = derivedUuid(`routine:${row.routine_id}:${dueAt}`);
    const db = this.deps.db;
    const inserted = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO crew_job (id, hire_id, kind, epoch, scope, requested_by, text, state)
           VALUES (?, ?, 'routine', ?, 'owner', ?, ?, 'queued')`,
        )
        .run(jobId, row.hire_id, epoch, requestedBy, text);
      db.prepare(
        `UPDATE crew_routine_cache SET last_fired = ?, data = json_set(data, '$.lastFired', ?, '$.lastRun', ?) WHERE routine_id = ?`,
      ).run(String(dueAt), dueAt, now, row.routine_id);
      return result.changes > 0;
    })();
    if (!inserted) return null;
    this.deps.hub.sendRoutineFired(jobId, row.routine_id, dueAt, now);
    return { routineId: row.routine_id, jobId, dueAt, late };
  }
}
