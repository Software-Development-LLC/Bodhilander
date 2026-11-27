import { describe, expect, mock, test } from 'bun:test';

const warn = mock(() => {});
mock.module('electron-log', () => ({ default: { warn, info: () => {}, error: () => {} } }));

const { EpochFence } = await import('../epoch');
const { LocalOutbox, PARK_AFTER, RESEND_FIRST_MS, RESEND_CAP_MS } = await import('../local-outbox');
import type { MachineFrame } from '../protocol';
import { HIRE, PERSON, crewDb, uuid } from './crew-db';

const reply = (n: number, epoch = 1) => ({ type: 'reply', id: uuid(n), hireId: HIRE, epoch, text: `r${n}` }) as MachineFrame & { id: string };

function setup() {
  const { raw, db } = crewDb();
  const fence = new EpochFence(db);
  const outbox = new LocalOutbox(db, fence, () => 0);
  const sent: string[] = [];
  const sender = { send: (text: string) => sent.push(text) };
  const ids = () => sent.map((t) => JSON.parse(t).id as string);
  const row = (id: string) => raw.query(`SELECT state, unanswered FROM crew_outbox_local WHERE id = ?`).get(id) as
    | { state: string; unanswered: number }
    | null;
  const audits = (event: string) => (raw.query(`SELECT COUNT(*) AS n FROM crew_audit WHERE event = ?`).get(event) as { n: number }).n;
  return { raw, db, fence, outbox, sent, sender, ids, row, audits };
}

describe('LocalOutbox', () => {
  test('drain sends every pending item in order, and ack deletes', () => {
    const { outbox, sender, ids, row } = setup();
    outbox.enqueue(reply(1), { hireId: HIRE, epoch: 1 });
    outbox.enqueue(reply(2), { hireId: HIRE, epoch: 1 });
    expect(outbox.drain(sender, 0)).toBe(2);
    expect(ids()).toEqual([uuid(1), uuid(2)]);
    expect(outbox.onAck(uuid(1))).toBe(true);
    expect(row(uuid(1))).toBeNull();
    expect(outbox.onAck(uuid(1))).toBe(false);
  });

  test('silence re-sends after 30 s, backing off to the 10-minute cap', () => {
    const { outbox, sender, ids } = setup();
    outbox.enqueue(reply(1), { hireId: HIRE, epoch: 1 });
    outbox.drain(sender, 0);
    outbox.tick(sender, RESEND_FIRST_MS - 1);
    expect(ids().length).toBe(1);
    outbox.tick(sender, RESEND_FIRST_MS);
    expect(ids().length).toBe(2);
    outbox.tick(sender, RESEND_FIRST_MS + 2 * RESEND_FIRST_MS - 1);
    expect(ids().length).toBe(2);
    outbox.tick(sender, RESEND_FIRST_MS + 2 * RESEND_FIRST_MS);
    expect(ids().length).toBe(3);
    let t = 3 * RESEND_FIRST_MS;
    for (let i = 0; i < 8; i += 1) {
      t += RESEND_CAP_MS;
      outbox.tick(sender, t);
    }
    const before = ids().length;
    outbox.tick(sender, t + RESEND_CAP_MS - 1);
    expect(ids().length).toBe(before);
  });

  test('jitter shortens a delay by up to 20%, never lengthens it', () => {
    const { db, fence, sender } = setup();
    const sent: number[] = [];
    const outbox = new LocalOutbox(db, fence, () => 1);
    outbox.enqueue(reply(1), { hireId: HIRE, epoch: 1 });
    outbox.drain({ send: (t) => sent.push(t.length) }, 0);
    outbox.tick({ send: (t) => sent.push(t.length) }, RESEND_FIRST_MS * 0.8 - 1);
    expect(sent.length).toBe(1);
    outbox.tick({ send: (t) => sent.push(t.length) }, RESEND_FIRST_MS * 0.8);
    expect(sent.length).toBe(2);
    void sender;
  });

  test('only a re-send the Hub read past counts as unanswered; ten park it', () => {
    const { outbox, sender, row, audits } = setup();
    outbox.enqueue(reply(1), { hireId: HIRE, epoch: 1 });
    outbox.drain(sender, 0);
    outbox.tick(sender, RESEND_FIRST_MS);
    expect(row(uuid(1))!.unanswered).toBe(0);
    let t = RESEND_FIRST_MS;
    for (let i = 0; i < PARK_AFTER; i += 1) {
      outbox.noteAnswered(Number.MAX_SAFE_INTEGER);
      t += RESEND_CAP_MS;
      outbox.tick(sender, t);
    }
    expect(row(uuid(1))).toEqual({ state: 'parked', unanswered: PARK_AFTER });
    expect(audits('outbox-parked')).toBe(1);
    expect(outbox.parkedCount(HIRE)).toBe(1);
  });

  test('an ack for a later frame overtakes the earlier ones only', () => {
    const { outbox, sender, row } = setup();
    outbox.enqueue(reply(1), { hireId: HIRE, epoch: 1 });
    outbox.enqueue(reply(2), { hireId: HIRE, epoch: 1 });
    outbox.enqueue(reply(3), { hireId: HIRE, epoch: 1 });
    outbox.drain(sender, 0);
    outbox.onAck(uuid(2));
    outbox.tick(sender, RESEND_FIRST_MS);
    expect(row(uuid(1))!.unanswered).toBe(1);
    expect(row(uuid(3))!.unanswered).toBe(0);
  });

  test('a parked item gets one try on the first drain and on Send again, and no timed re-sends', () => {
    const { raw, db, fence, sender, ids } = setup();
    raw.exec(`INSERT INTO crew_outbox_local (id, hire_id, epoch, frame_type, protocol_version, body, state)
              VALUES ('${uuid(1)}', '${HIRE}', 1, 'reply', 2, '{"id":"${uuid(1)}"}', 'parked')`);
    const outbox = new LocalOutbox(db, fence, () => 0);
    expect(outbox.drain(sender, 0)).toBe(1);
    expect(outbox.drain(sender, 1)).toBe(0);
    outbox.tick(sender, RESEND_CAP_MS * 10);
    expect(ids().length).toBe(1);
    expect(outbox.sendAgain(uuid(1), sender, 2)).toBe(true);
    expect(ids().length).toBe(2);
  });

  test('an item below the known epoch is never sent', () => {
    const { outbox, fence, sender, ids, row } = setup();
    outbox.enqueue(reply(1, 1), { hireId: HIRE, epoch: 1 });
    fence.observe(HIRE, 2);
    expect(outbox.drain(sender, 0)).toBe(0);
    expect(ids()).toEqual([]);
    expect(row(uuid(1))!.state).toBe('unsendable');
  });

  test('a refusal deletes the item, audits it, and acts on the job by reason', () => {
    const { raw, outbox, sender, row, audits } = setup();
    for (const [n, job] of [[1, 'j1'], [2, 'j2'], [3, 'j3']] as const) {
      raw.exec(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by) VALUES ('${job}', '${HIRE}', 1, 'owner', '${PERSON}')`);
      outbox.enqueue(reply(n), { hireId: HIRE, epoch: 1, jobId: job });
    }
    outbox.drain(sender, 0);
    expect(outbox.onRefused(uuid(1), 'closed')?.action).toBe('drop-job');
    expect(outbox.onRefused(uuid(2), 'malformed')?.action).toBe('dead-job');
    expect(outbox.onRefused(uuid(3), 'stale-epoch')?.action).toBe('sync');
    const jobs = raw.query(`SELECT id, state FROM crew_job ORDER BY id`).all();
    expect(jobs).toEqual([
      { id: 'j1', state: 'dropped' },
      { id: 'j2', state: 'dead' },
      { id: 'j3', state: 'queued' },
    ]);
    expect(row(uuid(1))).toBeNull();
    expect(audits('refused')).toBe(3);
    expect(outbox.onRefused(uuid(1), 'closed')).toBeNull();
  });

  test('every documented reason maps, and an unknown one does nothing but warn', () => {
    const { outbox } = setup();
    const expected = {
      'not-home': 'sync', unknown: 'none', 'wrong-hire': 'none', scope: 'fail-call', paused: 'fail-call',
    } as const;
    let n = 10;
    for (const [reason, action] of Object.entries(expected)) {
      outbox.enqueue(reply(n), { hireId: HIRE, epoch: 1 });
      expect(outbox.onRefused(uuid(n), reason)?.action).toBe(action);
      n += 1;
    }
    warn.mockClear();
    outbox.enqueue(reply(99), { hireId: HIRE, epoch: 1 });
    expect(outbox.onRefused(uuid(99), 'brand-new')?.action).toBe('none');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('prune drops rows this build no longer speaks', () => {
    const { raw, outbox, audits } = setup();
    outbox.enqueue(reply(1), { hireId: HIRE, epoch: 1 });
    raw.exec(`INSERT INTO crew_outbox_local (id, frame_type, protocol_version, body) VALUES ('old', 'reply', 1, '{}')`);
    raw.exec(`INSERT INTO crew_outbox_local (id, frame_type, protocol_version, body) VALUES ('gone', 'execute', 2, '{}')`);
    expect(outbox.prune()).toBe(2);
    expect((raw.query(`SELECT id FROM crew_outbox_local`).all() as { id: string }[]).map((r) => r.id)).toEqual([uuid(1)]);
    expect(audits('outbox-dropped')).toBe(2);
  });

  test('dropAll leaves nothing sendable', () => {
    const { outbox, sender } = setup();
    outbox.enqueue(reply(1), { hireId: HIRE, epoch: 1 });
    outbox.dropAll();
    expect(outbox.drain(sender, 0)).toBe(0);
    expect(outbox.sendNow(uuid(1), sender, 0)).toBe(false);
  });
});
