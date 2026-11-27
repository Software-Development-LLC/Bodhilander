import { describe, expect, test } from 'bun:test';
import type { ClaudeAccount } from '../../../shared/types';
import { isMoveRaisedHere, makeHomeHere, moveDecided, movePayload, unlinkHere, type HomeDeps } from '../home';
import type { CardDecisionFrame, MovePayload } from '../protocol';
import { crewDb, HIRE, MACHINE, type Db } from './crew-db';

function putHire(db: Db, hireId: string, body: Record<string, unknown>): void {
  db.prepare(`INSERT OR REPLACE INTO crew_hire_cache (hire_id, rev, home_machine_id, epoch, data) VALUES (?, 1, ?, ?, ?)`).run(
    hireId,
    (body.homeMachineId as string | null) ?? null,
    (body.epoch as number) ?? 1,
    JSON.stringify(body),
  );
}

const ref = { accountUuid: 'u-1', email: 'w@x.com', label: 'Work' };
const work = { id: 'acc-1', label: 'Work here', configDir: '/d/1', email: 'w@x.com' } as ClaudeAccount;

function setup(over: Partial<HomeDeps> = {}, hire: Record<string, unknown> = {}) {
  const { db } = crewDb();
  putHire(db, HIRE, { name: 'Fresh PO', roleId: 'fresh-po', homeMachineId: 'm-old', state: 'held:no-home', epoch: 5, accountRef: ref, ownerId: 'p-owner', ...hire });
  const raised: [string, MovePayload][] = [];
  const unlinked: string[] = [];
  const told: string[] = [];
  const deps: HomeDeps = {
    db,
    machineId: () => MACHINE,
    online: () => true,
    resolve: (r) => (r.accountUuid === 'u-1' ? work : null),
    signedIn: () => true,
    raiseMove: (hireId, payload) => (raised.push([hireId, payload]), 'r-1'),
    sendUnlink: (id) => (unlinked.push(id), true),
    tellOwner: (t) => told.push(t),
    ...over,
  };
  return { db, deps, raised, unlinked, told };
}

const decision = (d: 'approved' | 'denied'): CardDecisionFrame => ({ type: 'card_decision', id: 'd-1', hireId: HIRE, epoch: 6, raiseId: 'r-1', decision: d, decidedBy: 'p-owner' });

describe('make this machine home', () => {
  test('a held:no-home hire raises a move card naming what this machine found for its account', () => {
    const t = setup();
    expect(makeHomeHere(t.deps, HIRE)).toEqual({ ok: true });
    expect(t.raised).toEqual([[HIRE, { account: 'signed-in', accountLabel: 'Work here' }]]);
    expect(isMoveRaisedHere(t.db, decision('approved'))).toBe(true);
    expect(isMoveRaisedHere(t.db, { ...decision('approved'), raiseId: 'r-other' })).toBe(false);
  });

  test('the account is reported missing or signed out as found, and the card is still raised', () => {
    expect(movePayload(setup({ resolve: () => null }).deps, ref)).toEqual({ account: 'missing', accountLabel: 'Work' });
    expect(movePayload(setup({ signedIn: () => false }).deps, ref)).toEqual({ account: 'signed-out', accountLabel: 'Work here' });
  });

  test('refused for a hire with a home, a hire already here, offline or unlinked', () => {
    expect(makeHomeHere(setup({}, { state: 'active' }).deps, HIRE).ok).toBe(false);
    expect(makeHomeHere(setup({}, { homeMachineId: MACHINE }).deps, HIRE).ok).toBe(false);
    expect(makeHomeHere(setup({ online: () => false }).deps, HIRE).ok).toBe(false);
    expect(makeHomeHere(setup({ machineId: () => null }).deps, HIRE).ok).toBe(false);
    expect(makeHomeHere(setup().deps, 'unknown').ok).toBe(false);
    const t = setup({ raiseMove: () => null });
    expect(makeHomeHere(t.deps, HIRE)).toEqual({ ok: false, error: "The move couldn't be queued." });
  });

  test('an approval with the account missing here tells the owner; a denial tells them it stays held', () => {
    const missing = setup({ resolve: () => null });
    moveDecided(missing.deps, decision('approved'));
    expect(missing.told).toEqual(["Fresh PO is moving to this machine. Its Claude account Work isn't signed in here, so it will hold until it is."]);
    const fine = setup();
    moveDecided(fine.deps, decision('approved'));
    expect(fine.told).toEqual(['Fresh PO is moving to this machine. Its queued messages run here once the old machine has stopped.']);
    const denied = setup();
    moveDecided(denied.deps, decision('denied'));
    expect(denied.told).toEqual(['Fresh PO stays without a home machine.']);
  });
});

describe('unlink', () => {
  test('unlinking this machine sends one unlink for its own id, only when online and linked', () => {
    const t = setup();
    expect(unlinkHere(t.deps)).toEqual({ ok: true });
    expect(t.unlinked).toEqual([MACHINE]);
    expect(unlinkHere(setup({ online: () => false }).deps).ok).toBe(false);
    expect(unlinkHere(setup({ machineId: () => null }).deps).ok).toBe(false);
  });
});
