import { describe, expect, test } from 'bun:test';
import { clearAccountState, INVITE_STASH, MACHINE_PREF_KEY } from './account';

function fakeStores() {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  return {
    local,
    session,
    stores: {
      local: { removeItem: (k: string) => void local.delete(k) },
      session: {
        removeItem: (k: string) => void session.delete(k),
        setItem: (k: string, v: string) => void session.set(k, v),
      },
    },
  };
}

describe('clearAccountState', () => {
  test('drops the machine preference — it belongs to the account, not the browser', () => {
    const { local, stores } = fakeStores();
    local.set(MACHINE_PREF_KEY, 'machine-a');
    clearAccountState(stores);
    expect(local.has(MACHINE_PREF_KEY)).toBe(false);
  });

  test('drops a stale invite when none is being carried across', () => {
    const { session, stores } = fakeStores();
    session.set(INVITE_STASH, '/i/old-code');
    clearAccountState(stores);
    expect(session.has(INVITE_STASH)).toBe(false);
  });

  // The invariant the ordering exists for: written back AFTER the wipe, not
  // protected from it. Stash-then-wipe passes every other test in this file
  // and drops the invite exactly when it matters.
  test('a carried invite survives the wipe it is performed alongside', () => {
    const { session, stores } = fakeStores();
    session.set(INVITE_STASH, '/i/old-code');
    clearAccountState(stores, '/i/new-code#fp');
    expect(session.get(INVITE_STASH)).toBe('/i/new-code#fp');
  });

  test('a carried invite replaces whatever was stashed before', () => {
    const { session, stores } = fakeStores();
    clearAccountState(stores, '/i/new-code#fp');
    expect(session.get(INVITE_STASH)).toBe('/i/new-code#fp');
  });

  test('carrying an invite does not spare the machine preference', () => {
    const { local, stores } = fakeStores();
    local.set(MACHINE_PREF_KEY, 'machine-a');
    clearAccountState(stores, '/i/new-code');
    expect(local.has(MACHINE_PREF_KEY)).toBe(false);
  });
});
