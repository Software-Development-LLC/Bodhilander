/**
 * The local mirror of what the Hub syncs. A pull asks for every change after
 * the last applied sequence; note and skill_bundle bodies arrive only when
 * fetched. An edit names the rev it expects; a conflict applies the Hub's copy.
 */
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { writeAudit } from './audit';
import type { EditFrame, EditKind, EditOp, EditResultFrame, SyncKind, SyncObject, SyncPageFrame, SyncPullFrame, SyncRef } from './protocol';

export const SYNC_SEQ_KEY = 'sync.seq';
export const SYNC_WANTED_KEY = 'sync.wanted';
export const PULL_RESEND_MS = 30_000;
export const FETCH_MAX = 200;
export const FETCH_TRIES = 3;

const FETCHED: ReadonlySet<SyncKind> = new Set<SyncKind>(['note', 'skill_bundle']);

const TABLES: Record<SyncKind, { table: string; id: string }> = {
  hire: { table: 'crew_hire_cache', id: 'hire_id' },
  role: { table: 'crew_role_cache', id: 'role_id' },
  skill_bundle: { table: 'crew_skill_cache', id: 'skill_id' },
  routine: { table: 'crew_routine_cache', id: 'routine_id' },
  note: { table: 'crew_note', id: 'note_id' },
};

type Body = Record<string, unknown>;

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const refKey = (r: SyncRef): string => `${r.kind}:${r.objectId}`;

export interface EditInput {
  id?: string;
  op: EditOp;
  kind: EditKind;
  objectId?: string;
  rev?: number;
  hireId?: string;
  epoch?: number;
  fields: Record<string, unknown>;
}

export class CrewSync {
  private pending: { frame: SyncPullFrame; sentMs: number; refs: SyncRef[] } | null = null;
  private readonly wanted = new Map<string, SyncRef>();
  private readonly tries = new Map<string, number>();
  private changedSince = false;

  constructor(
    private readonly db: Database.Database,
    private readonly newId: () => string = randomUUID,
  ) {
    for (const ref of this.loadWanted()) this.wanted.set(refKey(ref), ref);
  }

  private loadWanted(): SyncRef[] {
    const row = this.db.prepare('SELECT value FROM crew_sync_state WHERE key = ?').get(SYNC_WANTED_KEY) as { value: string } | undefined;
    try {
      const refs = JSON.parse(row?.value ?? '[]') as Partial<SyncRef>[];
      return refs.filter((r): r is SyncRef => typeof r?.kind === 'string' && r.kind in TABLES && typeof r.objectId === 'string');
    } catch {
      return [];
    }
  }

  /** The bodies still owed are kept with the sequence, so a restart never skips past them. */
  private saveWanted(): void {
    this.db
      .prepare('INSERT INTO crew_sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SYNC_WANTED_KEY, JSON.stringify([...this.wanted.values()]));
  }

  /** After an unlink nothing owed is fetched again. */
  forget(): void {
    this.wanted.clear();
    this.tries.clear();
    this.pending = null;
  }

  since(): number {
    const row = this.db.prepare('SELECT value FROM crew_sync_state WHERE key = ?').get(SYNC_SEQ_KEY) as { value: string } | undefined;
    const n = Number(row?.value);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  private setSince(seq: number): void {
    this.db
      .prepare('INSERT INTO crew_sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SYNC_SEQ_KEY, String(seq));
  }

  cachedRev(kind: SyncKind, objectId: string): number | null {
    const { table, id } = TABLES[kind];
    const row = this.db.prepare(`SELECT rev FROM ${table} WHERE ${id} = ?`).get(objectId) as { rev: number } | undefined;
    return row ? row.rev : null;
  }

  private pull(now: number): SyncPullFrame {
    for (const key of this.tries.keys()) if (!this.wanted.has(key)) this.tries.delete(key);
    const spent = [...this.wanted].filter(([key]) => (this.tries.get(key) ?? 0) >= FETCH_TRIES);
    for (const [key, ref] of spent) {
      this.wanted.delete(key);
      this.tries.delete(key);
      writeAudit(this.db, null, 'sync-body-missing', ref);
    }
    if (spent.length > 0) this.saveWanted();
    const refs = [...this.wanted.values()].slice(0, FETCH_MAX);
    for (const ref of refs) this.tries.set(refKey(ref), (this.tries.get(refKey(ref)) ?? 0) + 1);
    const frame: SyncPullFrame = { type: 'sync_pull', id: this.newId(), since: this.since() };
    if (refs.length > 0) frame.fetch = refs;
    this.pending = { frame, sentMs: now, refs };
    this.changedSince = false;
    return frame;
  }

  /** On every welcome: a fresh pull from the last applied sequence. */
  onConnect(now: number): SyncPullFrame {
    return this.pull(now);
  }

  /** A change notice. While a pull is out, the next one waits for its page. */
  onChange(seq: number, now: number): SyncPullFrame | null {
    if (seq <= this.since()) return null;
    return this.request(now);
  }

  /** Ask for one object's body, on this pull or the next. */
  fetch(ref: SyncRef, now: number): SyncPullFrame | null {
    this.wanted.set(refKey(ref), { kind: ref.kind, objectId: ref.objectId });
    this.saveWanted();
    return this.request(now);
  }

  cachedBody(kind: SyncKind, objectId: string): Body | null {
    const { table, id } = TABLES[kind];
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE ${id} = ?`).get(objectId) as { data: string } | undefined;
    try {
      return row ? (JSON.parse(row.data) as Body) : null;
    } catch {
      return null;
    }
  }

  /** Pull now, or right after the page already on its way. */
  request(now: number): SyncPullFrame | null {
    if (this.pending) {
      this.changedSince = true;
      return null;
    }
    return this.pull(now);
  }

  /** Silence is not a refusal: an unanswered pull is sent again. */
  resend(now: number): SyncPullFrame | null {
    if (!this.pending || now - this.pending.sentMs < PULL_RESEND_MS) return null;
    this.pending.sentMs = now;
    return this.pending.frame;
  }

  pendingId(): string | null {
    return this.pending?.frame.id ?? null;
  }

  onClosed(): void {
    this.pending = null;
  }

  /** Apply one page and return the pull that follows it, if any. A page for another pull is ignored. */
  onPage(frame: SyncPageFrame, now: number): SyncPullFrame | null {
    const pending = this.pending;
    if (pending?.frame.id !== frame.id) return null;
    this.pending = null;
    this.db.transaction(() => {
      for (const obj of frame.changes) this.applyOne(obj);
      if (!frame.more) for (const ref of pending.refs) this.wanted.delete(refKey(ref));
      if (frame.next > this.since()) this.setSince(frame.next);
      this.saveWanted();
    })();
    if (frame.more || this.wanted.size > 0 || this.changedSince) return this.pull(now);
    return null;
  }

  /** Write one object to its cache. A header without its body is queued for fetching. */
  apply(obj: SyncObject): void {
    this.db.transaction(() => {
      this.applyOne(obj);
      this.saveWanted();
    })();
  }

  private applyOne(obj: SyncObject): void {
    const { table, id } = TABLES[obj.kind];
    const key = refKey(obj);
    const cached = this.cachedRev(obj.kind, obj.objectId);
    if (obj.deleted) {
      this.wanted.delete(key);
      this.db.prepare(`DELETE FROM ${table} WHERE ${id} = ?`).run(obj.objectId);
      return;
    }
    if (cached !== null && cached >= obj.rev) {
      this.wanted.delete(key);
      return;
    }
    if (obj.body === undefined) {
      if (FETCHED.has(obj.kind)) this.wanted.set(key, { kind: obj.kind, objectId: obj.objectId });
      return;
    }
    this.wanted.delete(key);
    this.write(obj.kind, obj.objectId, obj.rev, obj.body);
  }

  private write(kind: SyncKind, objectId: string, rev: number, body: Body): void {
    const data = JSON.stringify(body);
    if (kind === 'routine') {
      this.db
        .prepare(
          `INSERT INTO crew_routine_cache (routine_id, hire_id, rev, data) VALUES (?, ?, ?, ?)
           ON CONFLICT(routine_id) DO UPDATE SET hire_id = excluded.hire_id, rev = excluded.rev, data = excluded.data`,
        )
        .run(objectId, str(body.hireId, ''), rev, data);
      return;
    }
    if (kind === 'note') {
      this.db
        .prepare(
          `INSERT INTO crew_note (note_id, hire_id, scope, path, rev, body, data) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(note_id) DO UPDATE SET hire_id = excluded.hire_id, scope = excluded.scope, path = excluded.path,
             rev = excluded.rev, body = excluded.body, data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
        )
        .run(objectId, str(body.hireId, ''), body.scope === 'owner' ? 'owner' : 'shared', str(body.path, objectId), rev, str(body.content, ''), data);
      return;
    }
    const { table, id } = TABLES[kind];
    const touched = kind === 'hire' ? ', updated_at = CURRENT_TIMESTAMP' : '';
    this.db
      .prepare(
        `INSERT INTO ${table} (${id}, rev, data) VALUES (?, ?, ?)
         ON CONFLICT(${id}) DO UPDATE SET rev = excluded.rev, data = excluded.data${touched}`,
      )
      .run(objectId, rev, data);
  }

  /** An edit names the rev it was made against; an update or delete defaults to the cached one. */
  buildEdit(input: EditInput): EditFrame {
    const frame: EditFrame = { type: 'edit', id: input.id ?? this.newId(), op: input.op, kind: input.kind, fields: input.fields };
    if (input.objectId !== undefined) frame.objectId = input.objectId;
    const rev = input.rev ?? (input.objectId === undefined ? null : this.cachedRev(input.kind, input.objectId));
    if (input.op !== 'create') {
      if (input.objectId === undefined || rev === null) throw new Error(`an ${input.op} edit needs an objectId and a rev`);
      frame.rev = rev;
    }
    if (input.hireId !== undefined) frame.hireId = input.hireId;
    if (input.epoch !== undefined) frame.epoch = input.epoch;
    return frame;
  }

  /** Our applied update lands in the cache at the Hub's new rev, unless a newer copy already synced. */
  private applyOwnEdit(sent: EditFrame, newRev: number | undefined): void {
    if (sent.op !== 'update' || sent.objectId === undefined || sent.rev === undefined || newRev === undefined) return;
    const { table, id } = TABLES[sent.kind];
    const row = this.db.prepare(`SELECT rev, data FROM ${table} WHERE ${id} = ?`).get(sent.objectId) as { rev: number; data: string } | undefined;
    if (!row || row.rev !== sent.rev || newRev <= row.rev) return;
    let body: Body;
    try {
      body = JSON.parse(row.data) as Body;
    } catch {
      body = {};
    }
    this.write(sent.kind, sent.objectId, newRev, { ...body, ...sent.fields });
  }

  /** A conflict applies the Hub's current object, so the UI shows the newer value. */
  onEditResult(frame: EditResultFrame, now: number, sent: EditFrame | null = null): SyncPullFrame | null {
    if (frame.result === 'applied' && sent) this.applyOwnEdit(sent, frame.rev);
    if (frame.result === 'conflict') {
      if (frame.current) this.apply(frame.current);
      writeAudit(this.db, null, 'edit-conflict', { id: frame.id, objectId: frame.objectId ?? frame.current?.objectId ?? null });
      if (!frame.current || this.wanted.size > 0) return this.request(now);
    }
    return null;
  }
}
