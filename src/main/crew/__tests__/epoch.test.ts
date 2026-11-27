import { describe, expect, test } from 'bun:test';
import { EpochFence } from '../epoch';
import type { DeliverFrame } from '../protocol';
import { HIRE, HIRE_B, PERSON, crewDb, uuid } from './crew-db';

const deliver = (n: number, epoch: number, hireId = HIRE): DeliverFrame => ({
  type: 'deliver',
  id: uuid(n),
  hireId,
  epoch,
  scope: 'owner',
  requestedBy: PERSON,
  text: `m${n}`,
  from: 'B',
});

function setup() {
  const { raw, db } = crewDb();
  const fence = new EpochFence(db);
  const state = (id: string) => (raw.query(`SELECT state FROM crew_job WHERE id = ?`).get(id) as { state: string }).state;
  const outbox = (id: string, hireId: string, epoch: number) =>
    raw
      .query(
        `INSERT INTO crew_outbox_local (id, hire_id, epoch, frame_type, protocol_version, body) VALUES (?, ?, ?, 'reply', 2, '{}')`,
      )
      .run(id, hireId, epoch);
  const outboxState = (id: string) =>
    (raw.query(`SELECT state FROM crew_outbox_local WHERE id = ?`).get(id) as { state: string }).state;
  return { raw, db, fence, state, outbox, outboxState };
}

describe('EpochFence', () => {
  test('stores a delivery under its epoch and scope, once', () => {
    const { raw, fence } = setup();
    expect(fence.recordDelivery(deliver(1, 3))).toBe('stored');
    expect(fence.recordDelivery(deliver(1, 3))).toBe('duplicate');
    expect(raw.query(`SELECT epoch, scope, requested_by FROM crew_job`).get()).toEqual({ epoch: 3, scope: 'owner', requested_by: PERSON });
  });

  test('a newer epoch drops older jobs and stops older outbox items, for that hire only', () => {
    const { fence, state, outbox, outboxState } = setup();
    fence.recordDelivery(deliver(1, 3));
    fence.recordDelivery(deliver(2, 3, HIRE_B));
    outbox(uuid(50), HIRE, 3);
    outbox(uuid(51), HIRE_B, 3);
    expect(fence.recordDelivery(deliver(3, 4))).toBe('stored');
    expect(state(uuid(1))).toBe('dropped');
    expect(state(uuid(3))).toBe('queued');
    expect(state(uuid(2))).toBe('queued');
    expect(outboxState(uuid(50))).toBe('unsendable');
    expect(outboxState(uuid(51))).toBe('pending');
    expect(fence.known(HIRE)).toBe(4);
  });

  test('a delivery older than the known epoch is kept dropped and never runs', () => {
    const { fence, state } = setup();
    fence.observe(HIRE, 5);
    expect(fence.recordDelivery(deliver(1, 4))).toBe('stale');
    expect(state(uuid(1))).toBe('dropped');
    expect(fence.stampFor(uuid(1))).toBeNull();
  });

  test('observe takes only a newer epoch', () => {
    const { fence } = setup();
    expect(fence.observe(HIRE, 2)).toBe(true);
    expect(fence.observe(HIRE, 2)).toBe(false);
    expect(fence.observe(HIRE, 1)).toBe(false);
    expect(fence.known(HIRE)).toBe(2);
  });

  test('stampFor gives the job its own epoch while that is current', () => {
    const { fence } = setup();
    fence.recordDelivery(deliver(1, 3));
    expect(fence.stampFor(uuid(1))).toEqual({ hireId: HIRE, epoch: 3 });
    expect(fence.stampFor(uuid(99))).toBeNull();
  });

  test('dropHire stops every job and item at any epoch', () => {
    const { fence, state, outbox, outboxState } = setup();
    fence.recordDelivery(deliver(1, 3));
    outbox(uuid(50), HIRE, 3);
    fence.dropHire(HIRE);
    expect(state(uuid(1))).toBe('dropped');
    expect(outboxState(uuid(50))).toBe('unsendable');
  });

  test('requeueRunning puts a running job back in the queue', () => {
    const { raw, fence, state } = setup();
    fence.recordDelivery(deliver(1, 3));
    raw.exec(`UPDATE crew_job SET state = 'running'`);
    fence.requeueRunning(HIRE);
    expect(state(uuid(1))).toBe('queued');
  });

  test('revokeEpoch prefers the latest job, then the synced epoch, then 0', () => {
    const { fence } = setup();
    expect(fence.revokeEpoch(HIRE)).toBe(0);
    fence.observe(HIRE, 2);
    expect(fence.revokeEpoch(HIRE)).toBe(2);
    fence.recordDelivery(deliver(1, 2));
    fence.recordDelivery(deliver(2, 7));
    expect(fence.revokeEpoch(HIRE)).toBe(7);
  });
});
