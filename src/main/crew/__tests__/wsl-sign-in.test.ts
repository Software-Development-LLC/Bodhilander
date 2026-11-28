import { describe, expect, test } from 'bun:test';
import { WslSignIn, type SignInChild } from '../wsl-sign-in';
import { TmpParentError } from '../run/sockets';

const TOKEN = `sk-ant-oat01-${'a'.repeat(80)}`;
const URL = 'https://claude.ai/oauth/authorize?code=true&state=x';

function setup(mode: 'token' | 'login', opts: { creds?: boolean; stored?: string | null; uuid?: string; parent?: string; mkdirFails?: boolean } = {}) {
  const scripts: string[] = [];
  const opened: string[] = [];
  const written: string[] = [];
  const records = new Set<string>();
  const calls: unknown[] = [];
  let out: (t: string) => void = () => {};
  let close: (c: number | null) => void = () => {};
  let spawned: string[] = [];
  const child: SignInChild = {
    write: (t) => void written.push(t),
    onOutput: (cb) => void (out = cb),
    onClose: (cb) => void (close = cb),
    kill: () => close(null),
  };
  const signIn = {
    mode: () => mode,
    storeToken: (id: string, output: string, belongs: (t: string) => boolean) => (calls.push(['store', id, output.includes(TOKEN), belongs(TOKEN)]), opts.stored ?? null),
    recordSignIn: (id: string) => void calls.push(['login', id]),
  };
  const s = new WslSignIn({
    signIn: signIn as never,
    records: { add: (n) => void records.add(n), remove: (n) => void records.delete(n), list: () => [...records] },
    sh: async (script) => {
      scripts.push(script);
      if (script.startsWith('umask 077') && opts.mkdirFails) return { code: 1, stdout: '', stderr: 'denied' };
      if (script.startsWith('p=/tmp/crt-1000')) return { code: 0, stdout: opts.parent ?? 'PARENT directory|1000|300\nMADE\n', stderr: '' };
      if (script.startsWith('test -s')) return { code: opts.creds ? 0 : 1, stdout: '', stderr: '' };
      if (script.startsWith('cat ')) return { code: 0, stdout: JSON.stringify({ oauthAccount: { accountUuid: opts.uuid ?? 'u-1' } }), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    spawn: (args) => ((spawned = args), child),
    openExternal: (u) => void opened.push(u),
    belongsTo: (id, _t, uuid) => id === 'a1' && uuid === (opts.uuid ?? 'u-1'),
    now: () => 0,
  });
  return { s, scripts, opened, written, records, calls, out: (t: string) => out(t), close: (c: number | null) => close(c), spawned: () => spawned };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Sign in for Crew on Windows', () => {
  test('setup-token runs inside BodhiCrew with the account dir and a private TMPDIR, and the token is kept on Windows', async () => {
    const u = setup('token');
    const done = u.s.start('a1');
    await tick();
    expect(u.spawned()).toEqual(expect.arrayContaining(['-u', 'crew', 'CLAUDE_CONFIG_DIR=/home/crew/.bodhilander/crew/accounts/a1', 'setup-token']));
    expect(u.spawned().some((a) => /^TMPDIR=\/tmp\/crt-1000\/\S+$/.test(a))).toBe(true);
    u.out(`Open this link: ${URL}\n`);
    u.out('more text https://other.example\n');
    expect(u.opened).toEqual([URL]);
    expect(u.s.submitCode('  abc#123  ')).toBe(true);
    expect(u.s.submitCode('two words')).toBe(false);
    expect(u.written).toEqual(['abc#123\n']);
    u.out(`${TOKEN}\n`);
    u.close(0);
    expect(await done).toEqual({ ok: true, accountUuid: 'u-1' });
    expect(u.calls).toEqual([['store', 'a1', true, true]]);
    expect(u.scripts.some((s) => s.includes(TOKEN))).toBe(false);
    await tick();
    expect(u.records.size).toBe(0);
    expect(u.s.active).toBe(false);
  });

  test('a refused token is reported and nothing is recorded', async () => {
    const u = setup('token', { stored: 'wrong-account' });
    const done = u.s.start('a1');
    await tick();
    u.close(0);
    expect(await done).toEqual({ ok: false, reason: 'wrong-account' });
  });

  test('the login fallback runs /login and records the sign-in only once credentials are in the account dir', async () => {
    const ok = setup('login', { creds: true, uuid: 'u-9' });
    const done = ok.s.start('a1');
    await tick();
    expect(ok.spawned().at(-1)).toBe('/login');
    ok.close(0);
    expect(await done).toEqual({ ok: true, accountUuid: 'u-9' });
    expect(ok.calls).toEqual([['login', 'a1']]);

    const none = setup('login', { creds: false });
    const failed = none.s.start('a1');
    await tick();
    none.close(0);
    expect(await failed).toEqual({ ok: false, reason: 'not-signed-in' });
    expect(none.calls).toEqual([]);
  });

  test('existing credentials do not make a cancelled or failed login a sign-in', async () => {
    for (const exit of [null, 1]) {
      const u = setup('login', { creds: true });
      const done = u.s.start('a1');
      await tick();
      u.close(exit);
      expect(await done).toEqual({ ok: false, reason: exit === null ? 'cancelled' : 'not-signed-in' });
      expect(u.calls).toEqual([]);
    }
  });

  test('a sign-in in progress names its TMPDIR, and none once it ends', async () => {
    const u = setup('token');
    const done = u.s.start('a1');
    await tick();
    expect(u.s.liveTmpNames()).toEqual([...u.records]);
    u.close(0);
    await done;
    expect(u.s.liveTmpNames()).toEqual([]);
  });

  test('a TMPDIR parent that is not ours rejects the sign-in and leaves no TMPDIR named as live', async () => {
    const u = setup('token', { parent: 'PARENT directory|0|777\n' });
    await expect(u.s.start('a1')).rejects.toBeInstanceOf(TmpParentError);
    expect(u.spawned()).toEqual([]);
    expect(u.s.liveTmpNames()).toEqual([]);
    expect(u.s.active).toBe(false);
  });

  test('an account dir that cannot be made rejects the sign-in and spawns nothing', async () => {
    const u = setup('token', { mkdirFails: true });
    await expect(u.s.start('a1')).rejects.toThrow('account-dir');
    expect(u.spawned()).toEqual([]);
    expect(u.s.liveTmpNames()).toEqual([]);
  });

  test('two sign-ins started together spawn one claude, and a cancel before the spawn spawns none', async () => {
    const u = setup('token');
    let spawns = 0;
    const first = u.s.start('a1');
    const second = u.s.start('a1');
    expect(await second).toEqual({ ok: false, reason: 'busy' });
    u.s.cancel();
    expect(await first).toEqual({ ok: false, reason: 'cancelled' });
    spawns = u.spawned().length;
    expect(spawns).toBe(0);
    expect(u.s.active).toBe(false);
  });

  test('a second sign-in waits for the first, and cancel ends it', async () => {
    const u = setup('token');
    const done = u.s.start('a1');
    await tick();
    expect(await u.s.start('a1')).toEqual({ ok: false, reason: 'busy' });
    u.s.cancel();
    expect(await done).toEqual({ ok: false, reason: 'cancelled' });
    expect(u.s.submitCode('abc')).toBe(false);
  });
});

describe('the Windows sign-in channels', () => {
  const { registerWindowsSignIn } = require('../wsl-sign-in') as typeof import('../wsl-sign-in');
  test('refuse off Windows, and pass a code and a cancel to the running sign-in', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    let current: WslSignIn | null = null;
    registerWindowsSignIn((c, fn) => void handlers.set(c, fn), () => current);
    expect(await handlers.get('crew:windowsSignIn')!('a1')).toEqual({ ok: false, reason: 'unavailable' });
    const u = setup('token');
    current = u.s;
    const done = handlers.get('crew:windowsSignIn')!('a1') as Promise<unknown>;
    await tick();
    expect(handlers.get('crew:windowsSignInCode')!(42)).toBe(false);
    expect(handlers.get('crew:windowsSignInCode')!('abc')).toBe(true);
    handlers.get('crew:windowsSignInCancel')!();
    expect(await done).toEqual({ ok: false, reason: 'cancelled' });
  });
});
