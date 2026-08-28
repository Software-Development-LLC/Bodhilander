/**
 * The context bridge. It forwards event payloads by hand, so a field main
 * added can be dropped here unnoticed; and channel names live here and in
 * index.ts with nothing joining them, so a rename fails silently at runtime.
 */

// Run with: bun test src/main/__tests__/preload.test.ts

import { describe, expect, test, mock } from 'bun:test';

type Listener = (event: unknown, data: unknown) => void;

let exposed: Record<string, unknown> = {};
const listeners = new Map<string, Listener[]>();
const invocations: { channel: string; args: unknown[] }[] = [];

/**
 * Covers what preload reaches for, and no more: it is the only consumer here.
 * The suite runs under `bun test --isolate`, so this registration cannot become
 * the subject of a file that drives electron for real.
 */
mock.module('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: Record<string, unknown>) => { exposed = api; },
  },
  ipcRenderer: {
    on: (channel: string, listener: Listener) => {
      const existing = listeners.get(channel) ?? [];
      existing.push(listener);
      listeners.set(channel, existing);
    },
    removeListener: (channel: string, listener: Listener) => {
      const existing = listeners.get(channel) ?? [];
      listeners.set(channel, existing.filter((l) => l !== listener));
    },
    invoke: async (channel: string, ...args: unknown[]) => {
      invocations.push({ channel, args });
      return undefined;
    },
    send: () => undefined,
  },
}));

await import('../preload');

function emit(channel: string, data: unknown): void {
  for (const listener of listeners.get(channel) ?? []) listener({}, data);
}

/** `exposed` is deliberately untyped — it is whatever preload handed across. */
function call(name: string, ...args: unknown[]): unknown {
  return (exposed[name] as (...a: unknown[]) => unknown)(...args);
}

function lastInvocation(): { channel: string; args: unknown[] } {
  return invocations[invocations.length - 1];
}

const onLoginCompleted = () =>
  exposed.onAccountLoginCompleted as (
    cb: (data: { accountId: string; email: string | null; verified: boolean }) => void,
  ) => () => void;

describe('onAccountLoginCompleted', () => {
  test('hands the renderer the whole payload, verification included', () => {
    const seen: unknown[] = [];
    const off = onLoginCompleted()((data) => { seen.push(data); });

    emit('accounts:login-completed', {
      accountId: 'a1',
      email: 'will@acme.test',
      verified: true,
    });

    expect(seen).toEqual([{ accountId: 'a1', email: 'will@acme.test', verified: true }]);
    off();
  });

  // The renderer decides between "signed in" and "could not confirm" on this
  // one field, so a bridge that dropped it would leave the overlay asserting
  // the confident wording on every login.
  test('an unverified completion arrives unverified, not merely absent', () => {
    const seen: { verified: boolean }[] = [];
    const off = onLoginCompleted()((data) => { seen.push(data); });

    emit('accounts:login-completed', { accountId: 'a1', email: null, verified: false });

    expect(seen[0].verified).toBe(false);
    expect('verified' in seen[0]).toBe(true);
    off();
  });

  test('the returned unsubscribe detaches the listener it registered', () => {
    const seen: unknown[] = [];
    const off = onLoginCompleted()((data) => { seen.push(data); });

    off();
    emit('accounts:login-completed', { accountId: 'a1', email: null, verified: true });

    expect(seen).toEqual([]);
  });

  test('two subscribers are independent, so closing one overlay keeps the panel fed', () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    const offFirst = onLoginCompleted()((d) => { first.push(d); });
    const offSecond = onLoginCompleted()((d) => { second.push(d); });

    offFirst();
    emit('accounts:login-completed', { accountId: 'a1', email: null, verified: true });

    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    offSecond();
  });
});

describe('the import/export bridge', () => {
  test('exposes an export, an import, and the ClaudeLander shortcut', () => {
    for (const name of ['exportGroups', 'importGroups', 'importFromClaudeLander']) {
      expect(typeof exposed[name]).toBe('function');
    }
  });

  test('each routes to the channel index.ts registers', () => {
    call('exportGroups');
    expect(lastInvocation().channel).toBe('export:groups');

    call('importGroups');
    expect(lastInvocation().channel).toBe('import:groups');

    call('importFromClaudeLander');
    expect(lastInvocation().channel).toBe('import:fromClaudeLander');
  });

  test('exposes the four steps of a handoff, each forwarding to its own channel', () => {
    for (const name of ['handoffPrepare', 'handoffPeek', 'handoffRestore', 'handoffDecline']) {
      expect(typeof exposed[name]).toBe('function');
    }

    call('handoffPrepare');
    expect(lastInvocation().channel).toBe('handoff:prepare');

    call('handoffPeek');
    expect(lastInvocation().channel).toBe('handoff:peek');

    call('handoffRestore', 'agent album alloy');
    expect(lastInvocation().channel).toBe('handoff:restore');
    expect(lastInvocation().args).toEqual(['agent album alloy']);

    call('handoffDecline', 'handoff-1');
    expect(lastInvocation().channel).toBe('handoff:decline');
    expect(lastInvocation().args).toEqual(['handoff-1']);
  });

  test('exposes the arrival report, and signing in to an account that already exists', () => {
    for (const name of ['arrivalRead', 'arrivalDismiss', 'arrivalResolveRelink', 'resumeAccountLogin']) {
      expect(typeof exposed[name]).toBe('function');
    }

    call('arrivalRead');
    expect(lastInvocation().channel).toBe('arrival:read');

    call('arrivalDismiss');
    expect(lastInvocation().channel).toBe('arrival:dismiss');

    call('arrivalResolveRelink', 's1', '/home/will/Work/api');
    expect(lastInvocation().channel).toBe('arrival:resolveRelink');
    expect(lastInvocation().args).toEqual(['s1', '/home/will/Work/api']);

    // Not `accounts:startLogin`: that one mints an account and rolls it back
    // on a spawn failure, which for a restored account would delete it.
    call('resumeAccountLogin', 'acct-1');
    expect(lastInvocation().channel).toBe('accounts:resumeLogin');
    expect(lastInvocation().args).toEqual(['acct-1']);
  });

  test('the folder picker forwards the directory it should open at', () => {
    call('selectDirectory', '/some/where');

    expect(lastInvocation().channel).toBe('dialog:selectDirectory');
    expect(lastInvocation().args).toEqual(['/some/where']);
  });

  test('updating a session carries its patch through unchanged', () => {
    call('updateDbSession', 's1', { workingDir: '/moved/here', state: 'stopped' });

    expect(lastInvocation().args).toEqual(['s1', { workingDir: '/moved/here', state: 'stopped' }]);
  });
});
