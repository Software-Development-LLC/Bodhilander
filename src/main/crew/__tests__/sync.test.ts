import { describe, expect, test } from 'bun:test';
import { CrewSync, PULL_RESEND_MS, SYNC_SEQ_KEY, SYNC_WANTED_KEY } from '../sync';
import type { SyncObject, SyncPageFrame } from '../protocol';
import { HIRE, crewDb, uuid } from './crew-db';

function setup() {
  const { raw, db } = crewDb();
  let n = 0;
  const sync = new CrewSync(db, () => uuid(++n));
  const rows = (sql: string) => raw.prepare(sql).all() as Record<string, unknown>[];
  return { raw, db, sync, rows };
}

const obj = (over: Partial<SyncObject> = {}): SyncObject => ({
  kind: 'role', objectId: 'po', rev: 1, seq: 1, hash: 'h', deleted: false, body: { role: 'po' }, ...over,
});
const page = (id: string, changes: SyncObject[], next: number, more = false): SyncPageFrame => ({
  type: 'sync_page', id, changes, next, more,
});

describe('CrewSync pulling', () => {
  test('the first pull starts at 0; a page moves the sequence and writes the cache', () => {
    const t = setup();
    const pull = t.sync.onConnect(0);
    expect(pull).toEqual({ type: 'sync_pull', id: uuid(1), since: 0 });
    expect(t.sync.onPage(page(pull.id, [obj({ seq: 4 })], 4), 0)).toBeNull();
    expect(t.sync.since()).toBe(4);
    expect(t.rows('SELECT role_id, rev, data FROM crew_role_cache')).toEqual([{ role_id: 'po', rev: 1, data: '{"role":"po"}' }]);
    expect(t.sync.onConnect(0).since).toBe(4);
  });

  test('the sequence survives a restart and is never moved back', () => {
    const t = setup();
    const p = t.sync.onConnect(0);
    t.sync.onPage(page(p.id, [], 9), 0);
    const again = new CrewSync(t.db, () => uuid(50));
    const p2 = again.onConnect(0);
    expect(p2.since).toBe(9);
    again.onPage(page(p2.id, [], 3), 0);
    expect(again.since()).toBe(9);
    expect(t.rows(`SELECT value FROM crew_sync_state WHERE key = '${SYNC_SEQ_KEY}'`)).toEqual([{ value: '9' }]);
  });

  test('more pulls again from next', () => {
    const t = setup();
    const p = t.sync.onConnect(0);
    const next = t.sync.onPage(page(p.id, [obj({ seq: 200 })], 200, true), 0);
    expect(next).toEqual({ type: 'sync_pull', id: uuid(2), since: 200 });
  });

  test('a page for another pull is ignored', () => {
    const t = setup();
    t.sync.onConnect(0);
    expect(t.sync.onPage(page(uuid(99), [obj({ seq: 4 })], 4), 0)).toBeNull();
    expect(t.sync.since()).toBe(0);
    expect(t.rows('SELECT * FROM crew_role_cache')).toEqual([]);
    expect(t.sync.pendingId()).toBe(uuid(1));
  });

  test('a change notice pulls only past the applied sequence, and waits for a pull already out', () => {
    const t = setup();
    const p = t.sync.onConnect(0);
    expect(t.sync.onChange(5, 0)).toBeNull();
    const after = t.sync.onPage(page(p.id, [], 3), 0);
    expect(after?.since).toBe(3);
    t.sync.onPage(page(after!.id, [], 5), 0);
    expect(t.sync.onChange(5, 0)).toBeNull();
    expect(t.sync.onChange(6, 0)).toEqual({ type: 'sync_pull', id: uuid(3), since: 5 });
  });

  test('an unanswered pull is sent again after 30 s, the same frame', () => {
    const t = setup();
    const p = t.sync.onConnect(1000);
    expect(t.sync.resend(1000 + PULL_RESEND_MS - 1)).toBeNull();
    expect(t.sync.resend(1000 + PULL_RESEND_MS)).toBe(p);
    expect(t.sync.resend(1000 + PULL_RESEND_MS + 1)).toBeNull();
    t.sync.onClosed();
    expect(t.sync.resend(10 ** 9)).toBeNull();
    expect(t.sync.pendingId()).toBeNull();
  });
});

describe('CrewSync applying objects', () => {
  test('each kind lands in its cache; a delete removes the row', () => {
    const t = setup();
    t.sync.apply(obj({ kind: 'hire', objectId: HIRE, rev: 2, body: { name: 'PO' } }));
    t.sync.apply(obj({ kind: 'skill_bundle', objectId: 'b1', body: { files: [] } }));
    t.sync.apply(obj({ kind: 'routine', objectId: 'r1', body: { hireId: HIRE, cron: '0 9 * * *' } }));
    t.sync.apply(obj({ kind: 'note', objectId: 'n1', rev: 3, body: { hireId: HIRE, scope: 'owner', path: 'owner/a.md', content: 'hello' } }));
    expect(t.rows('SELECT hire_id, rev, data FROM crew_hire_cache')).toEqual([{ hire_id: HIRE, rev: 2, data: '{"name":"PO"}' }]);
    expect(t.rows('SELECT skill_id, rev FROM crew_skill_cache')).toEqual([{ skill_id: 'b1', rev: 1 }]);
    expect(t.rows('SELECT routine_id, hire_id FROM crew_routine_cache')).toEqual([{ routine_id: 'r1', hire_id: HIRE }]);
    expect(t.rows('SELECT note_id, hire_id, scope, path, rev, body FROM crew_note')).toEqual([
      { note_id: 'n1', hire_id: HIRE, scope: 'owner', path: 'owner/a.md', rev: 3, body: 'hello' },
    ]);
    t.sync.apply(obj({ kind: 'note', objectId: 'n1', rev: 4, deleted: true, body: undefined }));
    expect(t.rows('SELECT * FROM crew_note')).toEqual([]);
  });

  test('a note without an owner scope is shared, and its path defaults to the object id', () => {
    const t = setup();
    t.sync.apply(obj({ kind: 'note', objectId: 'n2', body: { hireId: HIRE, scope: 'circle' } }));
    expect(t.rows('SELECT scope, path, body FROM crew_note')).toEqual([{ scope: 'shared', path: 'n2', body: '' }]);
  });

  test('a sync update keeps the epoch the fence recorded', () => {
    const t = setup();
    t.raw.prepare(`INSERT INTO crew_hire_cache (hire_id, epoch) VALUES (?, 7)`).run(HIRE);
    t.sync.apply(obj({ kind: 'hire', objectId: HIRE, rev: 3, body: { name: 'PO' } }));
    expect(t.rows('SELECT epoch, rev FROM crew_hire_cache')).toEqual([{ epoch: 7, rev: 3 }]);
  });

  test('an object no newer than the cache is left alone', () => {
    const t = setup();
    t.sync.apply(obj({ rev: 3, body: { v: 'new' } }));
    t.sync.apply(obj({ rev: 3, body: { v: 'same rev' } }));
    t.sync.apply(obj({ rev: 2, body: { v: 'old' } }));
    expect(t.rows('SELECT rev, data FROM crew_role_cache')).toEqual([{ rev: 3, data: '{"v":"new"}' }]);
  });

  test('a note or skill header is fetched on the next pull, and only once it is newer', () => {
    const t = setup();
    t.sync.apply(obj({ kind: 'skill_bundle', objectId: 'b1', rev: 2, body: { files: [] } }));
    const p = t.sync.onConnect(0);
    const headers = [
      obj({ kind: 'note', objectId: 'n1', rev: 1, seq: 5, body: undefined }),
      obj({ kind: 'skill_bundle', objectId: 'b1', rev: 2, seq: 6, body: undefined }),
      obj({ kind: 'role', objectId: 'r', rev: 1, seq: 7, body: undefined }),
    ];
    const fetch = t.sync.onPage(page(p.id, headers, 7), 0);
    expect(fetch).toEqual({ type: 'sync_pull', id: uuid(2), since: 7, fetch: [{ kind: 'note', objectId: 'n1' }] });
    expect(t.rows('SELECT * FROM crew_note')).toEqual([]);
    expect(t.rows('SELECT * FROM crew_role_cache')).toEqual([]);
    const body = obj({ kind: 'note', objectId: 'n1', rev: 1, seq: 5, body: { hireId: HIRE, path: 'shared/a.md', content: 'x' } });
    expect(t.sync.onPage(page(fetch!.id, [body], 7), 0)).toBeNull();
    expect(t.rows('SELECT body FROM crew_note')).toEqual([{ body: 'x' }]);
  });

  test('every header on a page is fetched together', () => {
    const t = setup();
    const p = t.sync.onConnect(0);
    const headers = ['n1', 'n2'].map((id, i) => obj({ kind: 'note', objectId: id, seq: i + 1, body: undefined }));
    expect(t.sync.onPage(page(p.id, headers, 2), 0)?.fetch).toEqual([
      { kind: 'note', objectId: 'n1' },
      { kind: 'note', objectId: 'n2' },
    ]);
  });

  test('a fetch the Hub cannot answer is not asked for again', () => {
    const t = setup();
    const p = t.sync.onConnect(0);
    const fetch = t.sync.onPage(page(p.id, [obj({ kind: 'note', objectId: 'gone', body: undefined })], 1), 0);
    expect(fetch?.fetch).toEqual([{ kind: 'note', objectId: 'gone' }]);
    expect(t.sync.onPage(page(fetch!.id, [], 1), 0)).toBeNull();
  });

  test('a fetch cut short by a full page is asked for again', () => {
    const t = setup();
    const p = t.sync.onConnect(0);
    const fetch = t.sync.onPage(page(p.id, [obj({ kind: 'note', objectId: 'n1', body: undefined })], 1), 0);
    expect(t.sync.onPage(page(fetch!.id, [], 1, true), 0)?.fetch).toEqual([{ kind: 'note', objectId: 'n1' }]);
  });
});

describe('CrewSync edits', () => {
  test('an update names the cached rev unless the caller gives one', () => {
    const t = setup();
    t.sync.apply(obj({ kind: 'routine', objectId: 'r1', rev: 4, body: { hireId: HIRE } }));
    expect(t.sync.buildEdit({ op: 'update', kind: 'routine', objectId: 'r1', fields: { cron: 'x' } })).toEqual({
      type: 'edit', id: uuid(1), op: 'update', kind: 'routine', objectId: 'r1', rev: 4, fields: { cron: 'x' },
    });
    expect(t.sync.buildEdit({ op: 'delete', kind: 'routine', objectId: 'r1', rev: 2, hireId: HIRE, epoch: 3, fields: {} })).toEqual({
      type: 'edit', id: uuid(2), op: 'delete', kind: 'routine', objectId: 'r1', rev: 2, hireId: HIRE, epoch: 3, fields: {},
    });
  });

  test('a create carries no rev; an update with nothing cached is refused locally', () => {
    const t = setup();
    expect(t.sync.buildEdit({ op: 'create', kind: 'hire', fields: { name: 'PO' } })).toEqual({
      type: 'edit', id: uuid(1), op: 'create', kind: 'hire', fields: { name: 'PO' },
    });
    expect(() => t.sync.buildEdit({ op: 'update', kind: 'hire', objectId: HIRE, fields: {} })).toThrow(/rev/);
    expect(() => t.sync.buildEdit({ op: 'update', kind: 'hire', rev: 1, fields: {} })).toThrow(/objectId/);
  });

  test('a conflict applies the current object, so the newer value shows', () => {
    const t = setup();
    t.sync.apply(obj({ kind: 'routine', objectId: 'r1', rev: 1, body: { hireId: HIRE, cron: 'old' } }));
    const current = obj({ kind: 'routine', objectId: 'r1', rev: 2, body: { hireId: HIRE, cron: 'theirs' } });
    expect(t.sync.onEditResult({ type: 'edit_result', id: uuid(9), result: 'conflict', objectId: 'r1', rev: 2, current }, 0)).toBeNull();
    expect(t.rows('SELECT rev, data FROM crew_routine_cache')).toEqual([{ rev: 2, data: '{"hireId":"11111111-1111-4111-8111-111111111111","cron":"theirs"}' }]);
    expect(t.rows(`SELECT event FROM crew_audit`)).toEqual([{ event: 'edit-conflict' }]);
  });

  test('a conflict without the current object, or with only its header, pulls', () => {
    const t = setup();
    expect(t.sync.onEditResult({ type: 'edit_result', id: uuid(9), result: 'conflict', objectId: 'r1' }, 0)?.type).toBe('sync_pull');
    const u = setup();
    const header = obj({ kind: 'skill_bundle', objectId: 'b1', rev: 2, body: undefined });
    expect(u.sync.onEditResult({ type: 'edit_result', id: uuid(9), result: 'conflict', current: header }, 0)?.fetch).toEqual([
      { kind: 'skill_bundle', objectId: 'b1' },
    ]);
  });

  test('an applied or refused edit pulls nothing and audits nothing', () => {
    const t = setup();
    expect(t.sync.onEditResult({ type: 'edit_result', id: uuid(9), result: 'applied', objectId: 'r1', rev: 2 }, 0)).toBeNull();
    expect(t.sync.onEditResult({ type: 'edit_result', id: uuid(9), result: 'refused', why: 'no' }, 0)).toBeNull();
    expect(t.rows('SELECT * FROM crew_audit')).toEqual([]);
  });
});

describe('CrewSync owed bodies', () => {
  const note = (over: Partial<SyncObject> = {}) => obj({ kind: 'note', objectId: 'n1', seq: 5, body: undefined, ...over });

  test('a restart between a header page and its fetch still fetches the body', () => {
    const t = setup();
    const p = t.sync.onConnect(0);
    const fetch = t.sync.onPage(page(p.id, [note()], 5), 0);
    expect(fetch?.fetch).toEqual([{ kind: 'note', objectId: 'n1' }]);
    const again = new CrewSync(t.db, () => uuid(60));
    const p2 = again.onConnect(0);
    expect(p2).toEqual({ type: 'sync_pull', id: uuid(60), since: 5, fetch: [{ kind: 'note', objectId: 'n1' }] });
    expect(again.onPage(page(p2.id, [note({ body: { content: 'x' } })], 5), 0)).toBeNull();
    expect(new CrewSync(t.db).onConnect(0).fetch).toBeUndefined();
  });

  test('a header applied outside a page is saved as owed too', () => {
    const t = setup();
    t.sync.apply(note());
    expect(new CrewSync(t.db).onConnect(0).fetch).toEqual([{ kind: 'note', objectId: 'n1' }]);
  });

  test('a fetched page with more to come keeps its refs owed across a restart', () => {
    const t = setup();
    const p = t.sync.onConnect(0);
    const f = t.sync.onPage(page(p.id, [note()], 5), 0)!;
    t.sync.onPage(page(f.id, [], 5, true), 0);
    expect(new CrewSync(t.db).onConnect(0).fetch).toEqual([{ kind: 'note', objectId: 'n1' }]);
  });

  test('a fetch the Hub answers with nothing is not owed after a restart', () => {
    const t = setup();
    const p = t.sync.onConnect(0);
    const f = t.sync.onPage(page(p.id, [note()], 5), 0)!;
    expect(t.sync.onPage(page(f.id, [], 5), 0)).toBeNull();
    expect(new CrewSync(t.db).onConnect(0).fetch).toBeUndefined();
  });

    test('an unreadable saved list is ignored, and unknown kinds are dropped', () => {
    const t = setup();
    const save = (v: string) => t.raw.prepare('INSERT OR REPLACE INTO crew_sync_state (key, value) VALUES (?, ?)').run(SYNC_WANTED_KEY, v);
    save('{oops');
    expect(new CrewSync(t.db).onConnect(0).fetch).toBeUndefined();
    save('{"kind":"note"}');
    expect(new CrewSync(t.db).onConnect(0).fetch).toBeUndefined();
    save('[{"kind":"widget","objectId":"w"},{"kind":"note","objectId":7},null,{"kind":"note","objectId":"n2"}]');
    expect(new CrewSync(t.db).onConnect(0).fetch).toEqual([{ kind: 'note', objectId: 'n2' }]);
  });

  test('forget drops what was owed and the pull in flight', () => {
    const t = setup();
    const p = t.sync.onConnect(0);
    t.sync.onPage(page(p.id, [note()], 5), 0);
    t.sync.request(0);
    t.sync.forget();
    expect(t.sync.pendingId()).toBeNull();
    expect(t.sync.onConnect(0).fetch).toBeUndefined();
    expect(t.sync.onPage(page(uuid(4), [], 5), 0)).toBeNull();
  });
});
