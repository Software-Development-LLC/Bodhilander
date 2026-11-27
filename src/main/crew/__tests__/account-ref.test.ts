import { describe, expect, mock, test } from 'bun:test';

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
    expect(resolveAccountRef({ accountUuid: null, email: 'ME@x.com', label: 'x' }, accounts)?.id).toBe('a');
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
  test('sends one hire update carrying accountRef, and carries sessions', async () => {
    const { changeHireAccount } = await import('../account-ref');
    const { crewDb } = await import('./crew-db');
    const { raw, db } = crewDb();
    raw.query(`INSERT INTO crew_thread (hire_id, thread_key, session_id, account_id) VALUES ('h1', 't1', 's1', 'a')`).run();
    identities['/d/b'] = { accountUuid: 'u-b', email: 'b@x.com' };
    const sent: unknown[] = [];
    const out = changeHireAccount(
      { db, sendEdit: (e) => (sent.push(e), 'e1'), configDirOf: (id) => `/d/${id}`, carry: () => true },
      'h1',
      account('b'),
    );
    expect(sent).toEqual([{ op: 'update', kind: 'hire', objectId: 'h1', fields: { accountRef: { accountUuid: 'u-b', email: 'b@x.com', label: 'L-b' } } }]);
    expect(JSON.stringify(sent)).not.toMatch(/claudeAccountRef|claude_account_ref|configDir/);
    expect(out).toEqual({ editId: 'e1', carried: { carried: 1, fresh: 0 } });
  });

  test('an account with no uuid is never sent', async () => {
    const { changeHireAccount } = await import('../account-ref');
    const { crewDb } = await import('./crew-db');
    identities['/d/c'] = { accountUuid: null, email: 'c@x.com' };
    const sent: unknown[] = [];
    expect(changeHireAccount({ db: crewDb().db, sendEdit: (e) => (sent.push(e), 'x'), configDirOf: () => null }, 'h1', account('c'))).toBe('unknown-account');
    expect(sent).toEqual([]);
  });
});
