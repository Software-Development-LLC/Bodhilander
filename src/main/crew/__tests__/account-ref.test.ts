import { describe, expect, mock, test } from 'bun:test';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const identities: Record<string, { accountUuid: string | null; email: string | null }> = {};
mock.module('../../account-identity', () => ({
  resolveAccountIdentity: (dir: string) => ({ loggedIn: true, ...(identities[dir] ?? { accountUuid: null, email: null }) }),
}));

const { accountRefFor, resolveAccountRef } = await import('../account-ref');
import type { ClaudeAccount } from '../../../shared/types';

const account = (id: string, email: string | null = null) => ({ id, label: `L-${id}`, configDir: `/d/${id}`, email }) as ClaudeAccount;

describe('account references', () => {
  test('a reference carries uuid, email and label, and no config dir', () => {
    identities['/d/a'] = { accountUuid: 'u-a', email: 'a@x.com' };
    const ref = accountRefFor(account('a'));
    expect(ref).toEqual({ accountUuid: 'u-a', email: 'a@x.com', label: 'L-a' });
  });

  test('resolves by uuid first, even when another row has the address', () => {
    identities['/d/a'] = { accountUuid: 'u-a', email: 'same@x.com' };
    identities['/d/b'] = { accountUuid: 'u-b', email: 'same@x.com' };
    const found = resolveAccountRef({ accountUuid: 'u-b', email: 'same@x.com', label: 'x' }, [account('a'), account('b')]);
    expect(found?.id).toBe('b');
  });

  test('falls back to email, case-insensitively, only against rows without their own uuid', () => {
    identities['/d/a'] = { accountUuid: 'u-other', email: 'me@x.com' };
    identities['/d/c'] = { accountUuid: null, email: null };
    const accounts = [account('a'), account('c', 'Me@X.com ')];
    expect(resolveAccountRef({ accountUuid: 'u-gone', email: 'me@x.com', label: 'x' }, accounts)?.id).toBe('c');
    expect(resolveAccountRef({ accountUuid: null, email: 'ME@x.com', label: 'x' }, [account('a')])?.id).toBe('a');
    expect(resolveAccountRef({ accountUuid: null, email: 'ME@x.com', label: 'x' }, accounts)).toBeNull();
  });

  test('two rows with no uuid sharing the address are ambiguous, so neither is picked', () => {
    identities['/d/p'] = { accountUuid: null, email: 'twin@x.com' };
    identities['/d/q'] = { accountUuid: null, email: 'TWIN@x.com' };
    expect(resolveAccountRef({ accountUuid: null, email: 'twin@x.com', label: 'x' }, [account('p'), account('q')])).toBeNull();
    expect(resolveAccountRef({ accountUuid: 'u-gone', email: 'twin@x.com', label: 'x' }, [account('p'), account('q')])).toBeNull();
  });

  test('nothing matching is held:missing', () => {
    identities['/d/a'] = { accountUuid: 'u-a', email: 'a@x.com' };
    expect(resolveAccountRef({ accountUuid: 'u-z', email: 'a@x.com', label: 'x' }, [account('a')])).toBeNull();
    expect(resolveAccountRef({ accountUuid: null, email: null, label: 'x' }, [account('a')])).toBeNull();
  });

  test('crew code never resolves through the session resolver or failover', async () => {
    const src = await Bun.file(new URL('../account-ref.ts', import.meta.url)).text();
    expect(src).toContain('resolveAccountIdentity');
    expect(src).not.toMatch(/account-resolver|account-failover/);
  });
});

describe('changing a hire\'s account', () => {
  const seed = async () => {
    const { AccountChanger } = await import('../account-ref');
    const { crewDb } = await import('./crew-db');
    const { raw, db } = crewDb();
    raw.query(`INSERT INTO crew_thread (hire_id, thread_key, session_id, account_id) VALUES ('h1', 't1', 's1', 'a')`).run();
    raw.query(`INSERT INTO crew_hire_cache (hire_id, rev) VALUES ('h1', 2)`).run();
    const queued = (id: string, state = 'pending') =>
      raw.query(`INSERT INTO crew_outbox_local (id, hire_id, frame_type, protocol_version, body, state) VALUES (?, 'h1', 'edit', 2, '{}', ?)`).run(id, state);
    identities['/d/b'] = { accountUuid: 'u-b', email: 'b@x.com' };
    const sent: unknown[] = [];
    let n = 0;
    const deps = { db, sendEdit: (e: unknown) => (sent.push(e), `e${++n}`), configDirOf: (id: string) => `/d/${id}`, carry: () => true };
    const changer = new AccountChanger(deps);
    const thread = () => raw.query(`SELECT account_id FROM crew_thread`).get() as { account_id: string };
    return { raw, changer, sent, thread, queued, restart: () => new AccountChanger(deps), AccountChanger, deps };
  };

  test('sends one hire update carrying accountRef, and carries sessions only once it is applied', async () => {
    const { changer, sent, thread } = await seed();
    expect(changer.change('h1', account('b'))).toEqual({ editId: 'e1' });
    expect(sent).toEqual([{ op: 'update', kind: 'hire', objectId: 'h1', hireId: 'h1', fields: { accountRef: { accountUuid: 'u-b', email: 'b@x.com', label: 'L-b' } } }]);
    expect(JSON.stringify(sent)).not.toMatch(/claudeAccountRef|claude_account_ref|configDir/);
    expect(thread().account_id).toBe('a');
    expect(changer.onEditResult({ id: 'other', result: 'applied' })).toBeNull();
    expect(changer.onEditResult({ id: 'e1', result: 'applied' })).toEqual({ carried: 1, fresh: 0 });
    expect(thread().account_id).toBe('b');
    expect(changer.onEditResult({ id: 'e1', result: 'applied' })).toBeNull();
  });

  test('a refused or conflicting edit leaves every thread where it was', async () => {
    const { changer, thread } = await seed();
    changer.change('h1', account('b'));
    changer.change('h1', account('b'));
    expect(changer.onEditResult({ id: 'e1', result: 'conflict' })).toBeNull();
    expect(changer.onEditResult({ id: 'e2', result: 'refused' })).toBeNull();
    expect(thread().account_id).toBe('a');
  });

  test('an edit applied after a restart still carries the sessions', async () => {
    const { changer, thread, restart } = await seed();
    changer.change('h1', account('b'));
    expect(restart().onEditResult({ id: 'e1', result: 'applied' })).toEqual({ carried: 1, fresh: 0 });
    expect(thread().account_id).toBe('b');
  });

  const pendingRows = (raw: { query(sql: string): { all(): unknown[] } }) =>
    raw.query(`SELECT key FROM crew_sync_state WHERE key LIKE 'account-change:%'`).all().length;

  test('a carry that throws after the edit applied is retried by settle, not lost with the outbox item', async () => {
    const { AccountChanger, deps, thread, raw } = await seed();
    const failing = new AccountChanger({ ...deps, carry: () => { throw new Error('disk'); } });
    failing.change('h1', account('b'));
    expect(() => failing.onEditResult({ id: 'e1', result: 'applied' })).toThrow('disk');
    expect(thread().account_id).toBe('a');
    const later = new AccountChanger(deps);
    expect(later.onEditResult({ id: 'e1', result: 'applied' })).toBeNull();
    expect(later.settle()).toEqual([{ carried: 1, fresh: 0 }]);
    expect(thread().account_id).toBe('b');
    expect(pendingRows(raw)).toBe(0);
    expect(later.settle()).toEqual([]);
  });

  test('settle forgets a change whose edit the fence, a purge or a refusal removed, and keeps one still queued', async () => {
    const { changer, raw, queued, thread } = await seed();
    changer.change('h1', account('b'));
    changer.change('h1', account('b'));
    changer.change('h1', account('b'));
    queued('e1');
    queued('e2', 'unsendable');
    expect(changer.settle()).toEqual([]);
    expect(raw.query(`SELECT key FROM crew_sync_state WHERE key LIKE 'account-change:%'`).all()).toEqual([{ key: 'account-change:e1' }]);
    expect(thread().account_id).toBe('a');
  });

  test('a hire the machine has not synced is refused before anything is sent', async () => {
    const { AccountChanger, deps, raw, sent } = await seed();
    raw.query(`UPDATE crew_hire_cache SET rev = 0`).run();
    expect(new AccountChanger(deps).change('h1', account('b'))).toEqual({ refused: 'hire-not-synced' });
    raw.query(`DELETE FROM crew_hire_cache`).run();
    expect(new AccountChanger(deps).change('h1', account('b'))).toEqual({ refused: 'hire-not-synced' });
    expect(sent).toEqual([]);
  });

  test('any other send failure is reported as such, not as an unsynced hire', async () => {
    const { AccountChanger, deps, raw } = await seed();
    const changer = new AccountChanger({ ...deps, sendEdit: () => { throw new Error('database is locked'); } });
    expect(changer.change('h1', account('b'))).toEqual({ refused: 'send-failed' });
    expect(pendingRows(raw)).toBe(0);
  });

  test('an account with no uuid is never sent', async () => {
    const { changer, sent } = await seed();
    identities['/d/c'] = { accountUuid: null, email: 'c@x.com' };
    expect(changer.change('h1', account('c'))).toEqual({ refused: 'unknown-account' });
    expect(sent).toEqual([]);
  });
});
