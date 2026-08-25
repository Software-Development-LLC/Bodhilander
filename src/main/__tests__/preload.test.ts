/**
 * The context bridge between main's events and the renderer that words a claim
 * from them. It forwards each payload by hand, so a field main added can be
 * dropped here and the renderer would never know it was told anything.
 */

// Run with: bun test src/main/__tests__/preload.test.ts

import { describe, expect, test, mock } from 'bun:test';

type Listener = (event: unknown, data: unknown) => void;

let exposed: Record<string, unknown> = {};
const listeners = new Map<string, Listener[]>();

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
    invoke: async () => undefined,
    send: () => undefined,
  },
}));

await import('../preload');

function emit(channel: string, data: unknown): void {
  for (const listener of listeners.get(channel) ?? []) listener({}, data);
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
