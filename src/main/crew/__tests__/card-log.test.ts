import { describe, expect, test } from 'bun:test';
import { HIRE, PERSON, crewDb, uuid } from './crew-db';
import { listCards, markCardAcked, recordCardDecision, recordCardRaise, dropRefusedCard } from '../card-log';
import type { CardRaiseFrame } from '../protocol';

const raise = (n: number, over: Partial<CardRaiseFrame> = {}): CardRaiseFrame => ({
  type: 'card_raise', id: uuid(n), hireId: HIRE, epoch: 1, kind: 'permission', tainted: false, payload: { tool: 'Bash', summary: 'Bash {"command":"ls"}' }, ...over,
});

function setup() {
  const t = crewDb();
  t.raw.query(`INSERT INTO crew_hire_cache (hire_id, rev, data) VALUES (?, 1, ?)`).run(HIRE, JSON.stringify({ name: 'Ada' }));
  return t;
}

describe('card log', () => {
  test('a raised card shows as sending until the Hub acks it, then waiting, then decided', () => {
    const { db } = setup();
    recordCardRaise(db, raise(1), 1000);
    expect(listCards(db)).toEqual([
      { raiseId: uuid(1), hireId: HIRE, hireName: 'Ada', kind: 'permission', summary: 'Bash {"command":"ls"}', raisedAt: 1000, decision: null, decidedBy: null, state: 'sending' },
    ]);
    markCardAcked(db, uuid(1));
    expect(listCards(db)?.[0].state).toBe('waiting');
    recordCardDecision(db, uuid(1), 'denied', PERSON);
    expect(listCards(db)?.[0]).toMatchObject({ decision: 'denied', decidedBy: PERSON, state: 'decided' });
  });

  test('a card whose run ended without a decision shows as closed', () => {
    const { raw, db } = setup();
    raw.query(`INSERT INTO crew_card (raise_id, job_id, hire_id, thread_key, scope, requested_by, kind, state) VALUES (?, ?, ?, 'chat:owner', 'owner', ?, 'permission', 'closed')`).run(uuid(1), uuid(9), HIRE, PERSON);
    recordCardRaise(db, raise(1), 1000);
    markCardAcked(db, uuid(1));
    expect(listCards(db)?.[0].state).toBe('closed');
  });

  test('a card whose run waited out the hold shows as parked', () => {
    const { raw, db } = setup();
    raw.query(`INSERT INTO crew_card (raise_id, job_id, hire_id, thread_key, scope, requested_by, kind, state) VALUES (?, ?, ?, 'chat:owner', 'owner', ?, 'permission', 'parked')`).run(uuid(1), uuid(9), HIRE, PERSON);
    recordCardRaise(db, raise(1), 1000);
    markCardAcked(db, uuid(1));
    expect(listCards(db)?.[0].state).toBe('parked');
  });

  test('a refused raise leaves the list and is audited; an ack for any other frame changes nothing', () => {
    const { raw, db } = setup();
    recordCardRaise(db, raise(1), 1000);
    recordCardRaise(db, raise(2, { kind: 'note_patch', payload: { path: 'team.md', rev: 1, baseContent: '', newContent: 'x' } }), 2000);
    markCardAcked(db, uuid(77));
    dropRefusedCard(db, uuid(1), 'scope');
    expect(listCards(db)?.map((c) => [c.raiseId, c.summary, c.state])).toEqual([[uuid(2), 'team.md', 'sending']]);
    expect(raw.query(`SELECT COUNT(*) AS n FROM crew_audit WHERE event = 'card-raise-refused'`).get()).toEqual({ n: 1 });
  });

  test('a decision for a card this machine never raised adds nothing', () => {
    const { db } = setup();
    recordCardDecision(db, uuid(5), 'approved', PERSON);
    expect(listCards(db)).toEqual([]);
  });
});
