import { describe, expect, test } from 'bun:test';
import { registerCrewSignIn } from '../crew-sign-in';

function setup(opts: { settles?: boolean | null; throws?: boolean } = {}) {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const resumed: string[] = [];
  const cancelled: string[] = [];
  const signedIn: string[] = [];
  let hook: ((id: string) => void) | null = null;
  registerCrewSignIn({
    handle: (channel, fn) => (handlers[channel] = fn),
    resumeLogin: (id) => {
      if (opts.throws) throw new Error('no pty');
      resumed.push(id);
      return { ptyId: `__login-${id}` };
    },
    loginSettled: () => (opts.settles === null ? new Promise(() => {}) : Promise.resolve(opts.settles ?? true)),
    cancelLogin: (ptyId) => cancelled.push(ptyId),
    recordSignIn: (id) => signedIn.push(id),
    setLoginCompletedHook: (fn) => (hook = fn),
    timeoutMs: 5,
  });
  const call = (id: unknown) => handlers['crew:signInAgain'](id) as Promise<unknown>;
  return { call, resumed, cancelled, signedIn, hook: () => hook };
}

describe('Crew sign in again', () => {
  test('resumes the login for the account and answers ok once it lands', async () => {
    const t = setup();
    expect(await t.call(' a1 ')).toEqual({ ok: true });
    expect(t.resumed).toEqual(['a1']);
  });

  test('a cancelled, unstartable, timed-out or nameless sign-in answers why', async () => {
    expect(await setup({ settles: false }).call('a1')).toEqual({ ok: false, error: 'Sign-in was cancelled.' });
    expect(await setup({ throws: true }).call('a1')).toEqual({ ok: false, error: "The sign-in couldn't start." });
    const slow = setup({ settles: null });
    expect(await slow.call('a1')).toEqual({ ok: false, error: 'Sign-in timed out.' });
    expect(slow.cancelled).toEqual(['__login-a1']);
    const t = setup();
    expect(await t.call(7)).toEqual({ ok: false, error: 'Account id is required.' });
    expect(t.resumed).toEqual([]);
  });

  test('a completed login records the Crew sign-in, which lifts an auth-failure hold', () => {
    const t = setup();
    t.hook()?.('a1');
    expect(t.signedIn).toEqual(['a1']);
  });
});
