import { describe, expect, mock, test } from 'bun:test';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const { createHire } = await import('../hire');
import type { HireDeps } from '../hire';
import type { ClaudeAccount } from '../../../shared/types';
import type { EditResultFrame } from '../protocol';
import type { EditInput } from '../sync';
import { crewDb, uuid } from './crew-db';

const ACCOUNT = { id: 'a1', label: 'Work Max', configDir: '/acct/a1', email: 'b@x.com' } as ClaudeAccount;

function setup(answer: EditResultFrame['result'] | null = 'applied', over: Partial<HireDeps> = {}) {
  const { raw, db } = crewDb();
  raw.query(`INSERT INTO crew_role_cache (role_id, rev, data) VALUES ('fresh-po', 1, '{"role":"fresh-po"}')`).run();
  raw.query(`INSERT INTO crew_role_cache (role_id, rev, data) VALUES ('gone', 1, '{"deleted":true}')`).run();
  const sent: EditInput[] = [];
  const deps: HireDeps = {
    db,
    online: () => true,
    accounts: () => [ACCOUNT],
    refFor: (a) => ({ accountUuid: 'u-a1', email: 'b@x.com', label: a.label }),
    sendEdit: (input) => (sent.push(input), 'e1'),
    editResult: async (id) => (answer === null ? null : { type: 'edit_result', id, result: answer, why: 'roleId is not a known role' }),
    newId: () => uuid(9),
    ...over,
  };
  return { deps, sent };
}

const INPUT = { name: ' Fresh PO ', roleId: 'fresh-po', repos: ['Org/app', 'Org/app'], accountId: 'a1' };

describe('hiring', () => {
  test('a valid hire is sent as a create with its id, trimmed name, distinct repos and the account by reference', async () => {
    const t = setup();
    expect(await createHire(t.deps, INPUT)).toEqual({ ok: true, hireId: uuid(9) });
    expect(t.sent).toEqual([
      { op: 'create', kind: 'hire', objectId: uuid(9), fields: { name: 'Fresh PO', roleId: 'fresh-po', repos: ['Org/app'], accountRef: { accountUuid: 'u-a1', email: 'b@x.com', label: 'Work Max' } } },
    ]);
  });

  test('the account is required, and one that has not signed in cannot be named', async () => {
    const none = setup();
    expect(await createHire(none.deps, { ...INPUT, accountId: null })).toEqual({ ok: false, error: 'Pick the Claude account this hire runs on.' });
    const unsigned = setup('applied', { refFor: (a) => ({ accountUuid: null, email: null, label: a.label }) });
    expect((await createHire(unsigned.deps, INPUT)).ok).toBe(false);
    expect(none.sent).toEqual([]);
    expect(unsigned.sent).toEqual([]);
  });

  test('an unknown or deleted role, a bad name or a bad repo is refused here, before anything is sent', async () => {
    for (const bad of [{ roleId: 'nope' }, { roleId: 'gone' }, { name: '' }, { name: 'x'.repeat(65) }, { repos: ['not a repo'] }, { repos: 'Org/app' }]) {
      const t = setup();
      expect((await createHire(t.deps, { ...INPUT, ...bad })).ok).toBe(false);
      expect(t.sent).toEqual([]);
    }
  });

  test("the Hub's refusal is shown; no answer yet says so; offline sends nothing", async () => {
    expect(await createHire(setup('refused').deps, INPUT)).toEqual({ ok: false, error: 'roleId is not a known role' });
    expect((await createHire(setup(null).deps, INPUT)).ok).toBe(false);
    const offline = setup('applied', { online: () => false });
    expect((await createHire(offline.deps, INPUT)).ok).toBe(false);
    expect(offline.sent).toEqual([]);
  });
});
