import { describe, expect, test } from 'bun:test';
import { registerCrewSignIn } from '../crew-sign-in';

function setup(opts: { settles?: boolean | null; throws?: boolean; onSettle?: () => void } = {}) {
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
    loginSettled: () => {
      if (opts.settles === null) return new Promise(() => {});
      opts.onSettle?.();
      return Promise.resolve(opts.settles ?? true);
    },
    cancelLogin: (ptyId) => cancelled.push(ptyId),
    recordSignIn: (id) => signedIn.push(id),
    setLoginCompletedHook: (fn) => (hook = fn),
    timeoutMs: 5,
  });
  const call = (id: unknown) => handlers['crew:signInAgain'](id) as Promise<unknown>;
  return { call, resumed, cancelled, signedIn, hook: () => hook };
}

describe('Crew sign in again', () => {
  test('two overlapping sign-ins for one account both record the login that lands after the first ends', async () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const settles: Array<(ok: boolean) => void> = [];
    const signedIn: string[] = [];
    let hook: ((id: string) => void) | null = null;
    let n = 0;
    registerCrewSignIn({
      handle: (channel, fn) => (handlers[channel] = fn),
      resumeLogin: () => ({ ptyId: `__login-${++n}` }),
      loginSettled: () => new Promise<boolean>((resolve) => settles.push(resolve)),
      cancelLogin: () => {},
      recordSignIn: (id) => signedIn.push(id),
      setLoginCompletedHook: (fn) => (hook = fn),
      timeoutMs: 60_000,
    });
    const first = handlers['crew:signInAgain']('a1') as Promise<unknown>;
    const second = handlers['crew:signInAgain']('a1') as Promise<unknown>;
    settles[0](true);
    expect(await first).toEqual({ ok: true });
    hook?.('a1');
    settles[1](true);
    expect(await second).toEqual({ ok: true });
    expect(signedIn).toEqual(['a1']);
  });

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

  test('a login started from Crew records the Crew sign-in when it lands, which lifts an auth-failure hold', async () => {
    let t: ReturnType<typeof setup> | null = null;
    t = setup({ onSettle: () => t?.hook()?.('a1') });
    expect(await t.call('a1')).toEqual({ ok: true });
    expect(t.signedIn).toEqual(['a1']);
  });

  test('a login started anywhere else leaves Crew sign-in state alone', async () => {
    const t = setup();
    t.hook()?.('a1');
    expect(t.signedIn).toEqual([]);
    await t.call('a1');
    t.hook()?.('a1');
    expect(t.signedIn).toEqual([]);
  });

  test('a Crew sign-in for one account does not record another account logging in meanwhile', async () => {
    let t: ReturnType<typeof setup> | null = null;
    t = setup({ onSettle: () => t?.hook()?.('a2') });
    await t.call('a1');
    expect(t.signedIn).toEqual([]);
  });
});
