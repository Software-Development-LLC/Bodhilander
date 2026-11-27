import { describe, expect, test } from 'bun:test';
import { registerCrewIpc } from '../crew-ipc';

function setup() {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const resumed: string[] = [];
  const signedIn: string[] = [];
  let hook: ((id: string) => void) | null = null;
  registerCrewIpc({
    handle: (channel, fn) => (handlers[channel] = fn),
    resumeLogin: (id) => (resumed.push(id), { ptyId: `__login-${id}` }),
    recordSignIn: (id) => signedIn.push(id),
    setLoginCompletedHook: (fn) => (hook = fn),
  });
  return { handlers, resumed, signedIn, hook: () => hook };
}

describe('Crew IPC', () => {
  test('crew:signInAgain starts the login for an existing account and hands back its pty', () => {
    const t = setup();
    expect(t.handlers['crew:signInAgain'](' a1 ')).toEqual({ ptyId: '__login-a1' });
    expect(t.resumed).toEqual(['a1']);
    expect(() => t.handlers['crew:signInAgain']('')).toThrow('Account id is required');
    expect(() => t.handlers['crew:signInAgain'](7)).toThrow('Account id is required');
    expect(t.resumed).toEqual(['a1']);
  });

  test('a completed login records the Crew sign-in, which lifts an auth-failure hold', () => {
    const t = setup();
    t.hook()?.('a1');
    expect(t.signedIn).toEqual(['a1']);
  });
});
