import { describe, expect, test } from 'bun:test';
import { IMAGE_UNAVAILABLE } from '../artifacts';
import {
  DISTRO, NO_WSL_MESSAGE, REPAIR_PROMPT, REPAIR_PROMPT_LOGIN, RepairLock, SETUP_NEEDED_MESSAGE, WSL1_MESSAGE, checkWsl, decodeWslOutput, parseWslList, repairWsl1,
  type RepairDeps, type WslExec, type WslResult,
} from '../wsl';

const ok = (stdout = ''): WslResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom'): WslResult => ({ code: 1, stdout: '', stderr });

/** Answers by the first argument that names an operation, and records every call. */
function fakeWsl(answers: Record<string, WslResult | ((args: string[]) => WslResult)>) {
  const calls: string[][] = [];
  const exec: WslExec = async (args) => {
    calls.push(args);
    const key = Object.keys(answers).find((k) => args.join(' ').includes(k));
    const a = key ? answers[key] : ok();
    return typeof a === 'function' ? a(args) : a;
  };
  return { exec, calls };
}

const LIST = (rows: string) => `  NAME            STATE           VERSION\n${rows}`;

describe('the WSL2 check', () => {
  test('wsl -l -v is read as UTF-16LE from a pipe', () => {
    const text = LIST('* BodhiCrew    Stopped         2\n');
    expect(decodeWslOutput(Buffer.from(`\uFEFF${text}`, 'utf16le'))).toBe(text);
    expect(decodeWslOutput(Buffer.from(text, 'utf8'))).toBe(text);
  });

  test('parses the list, default marker included', () => {
    expect(parseWslList(LIST('* Ubuntu-24.04    Running         2\n  BodhiCrew       Stopped         1\n'))).toEqual([
      { name: 'Ubuntu-24.04', state: 'Running', version: 2, isDefault: true },
      { name: 'BodhiCrew', state: 'Stopped', version: 1, isDefault: false },
    ]);
  });

  test('(a) BodhiCrew on version 1 is WSL1, and Repair is offered', async () => {
    const { exec } = fakeWsl({ '-l -v': ok(LIST('  BodhiCrew   Stopped   1\n')) });
    expect(await checkWsl(exec)).toEqual({ state: 'wsl1', message: WSL1_MESSAGE });
  });

  test('(b) BodhiCrew missing, or no distros at all, offers setup', async () => {
    expect(await checkWsl(fakeWsl({ '-l -v': ok(LIST('* Ubuntu   Running   2\n')) }).exec)).toEqual({ state: 'missing', message: SETUP_NEEDED_MESSAGE });
    const none = { code: 4294967295, stdout: 'Windows Subsystem for Linux has no installed distributions.', stderr: '' };
    expect((await checkWsl(fakeWsl({ '-l -v': none }).exec)).state).toBe('missing');
  });

  test("(c) the person's distros are never used, whichever is first", async () => {
    const { exec, calls } = fakeWsl({ '-l -v': ok(LIST('* Debian   Running   2\n  Ubuntu-24.04   Stopped   2\n')) });
    expect((await checkWsl(exec)).state).toBe('missing');
    expect(calls).toEqual([['-l', '-v']]);
  });

  test('(d) no WSL gives the install steps', async () => {
    expect(await checkWsl(fakeWsl({ '-l -v': { code: null, stdout: '', stderr: 'ENOENT' } }).exec)).toEqual({ state: 'no-wsl', message: NO_WSL_MESSAGE });
    const notInstalled = { code: 1, stdout: 'The Windows Subsystem for Linux is not installed.', stderr: '' };
    expect((await checkWsl(fakeWsl({ '-l -v': notInstalled }).exec)).state).toBe('no-wsl');
  });

  test('only BodhiCrew on version 2 passes', async () => {
    expect(await checkWsl(fakeWsl({ '-l -v': ok(LIST('* Debian  Running  2\n  BodhiCrew  Stopped  2\n')) }).exec)).toEqual({ state: 'ok' });
  });
});

describe('the Repair lock', () => {
  test('one holder at a time, never waits, and a stale release does nothing', () => {
    const lock = new RepairLock();
    const release = lock.tryAcquire();
    expect(release).not.toBeNull();
    expect(lock.tryAcquire()).toBeNull();
    release?.();
    const again = lock.tryAcquire();
    release?.();
    expect(lock.held).toBe(true);
    again?.();
    expect(lock.held).toBe(false);
  });
});

function repairDeps(wsl: ReturnType<typeof fakeWsl>, over: Partial<RepairDeps> = {}) {
  const removed: string[] = [];
  const prompts: string[] = [];
  const lock = new RepairLock();
  const heldAt: Record<string, boolean> = {};
  const exec: WslExec = async (args, opts) => {
    heldAt[args[0]] = lock.held;
    return wsl.exec(args, opts);
  };
  const deps: RepairDeps = {
    exec,
    lock,
    fetchRootfs: async () => 'C:\\dl\\rootfs.tar.gz',
    removeFile: (f) => void removed.push(f),
    exists: () => false,
    confirm: async (p) => (prompts.push(p), true),
    loginFallback: false,
    freeBytes: async () => 100,
    distroUsedBytes: async () => 10,
    installDir: 'C:\\L\\Bodhilander\\crew\\wsl',
    backupDir: 'C:\\L\\Bodhilander\\crew\\backup',
    now: () => new Date('2026-11-27T10:00:00Z'),
    ...over,
  };
  return { deps, removed, prompts, lock, heldAt };
}

const EMPTY = { find: ok('') };
const CONTENT = { find: ok('/home/crew/.bodhilander/crew/hires/h1\n') };
const ops = (calls: string[][]) => calls.map((c) => (c[0] === '-d' ? c[5] : c[0]));

describe('Repair of a WSL1 setup', () => {
  test('an unlinked PC, an offline Hub or a bad hash changes nothing and takes no lock', async () => {
    const wsl = fakeWsl({});
    const t = repairDeps(wsl, { fetchRootfs: async () => Promise.reject(new Error('mismatch')) });
    expect(await repairWsl1(t.deps)).toEqual({ result: 'no-image', message: IMAGE_UNAVAILABLE });
    expect(wsl.calls).toEqual([]);
    expect(t.lock.held).toBe(false);
  });

  test('set-version succeeding is the whole Repair, and the download is deleted', async () => {
    const wsl = fakeWsl({ '--set-version': ok() });
    const t = repairDeps(wsl);
    expect(await repairWsl1(t.deps)).toEqual({ result: 'converted' });
    expect(wsl.calls).toEqual([['--set-version', DISTRO, '2']]);
    expect(t.removed).toEqual(['C:\\dl\\rootfs.tar.gz']);
  });

  test('set-version failing with no hires or accounts re-imports under the lock, with --version 2', async () => {
    const wsl = fakeWsl({ '--set-version': fail(), ...EMPTY });
    const t = repairDeps(wsl);
    expect(await repairWsl1(t.deps)).toEqual({ result: 'reimported' });
    expect(ops(wsl.calls)).toEqual(['--set-version', 'find', '--unregister', '--import']);
    expect(wsl.calls.at(-1)).toEqual(['--import', DISTRO, t.deps.installDir, 'C:\\dl\\rootfs.tar.gz', '--version', '2']);
    expect(t.heldAt['--set-version']).toBe(false);
    expect(t.heldAt['--unregister']).toBe(true);
    expect(t.prompts).toEqual([]);
    expect(t.lock.held).toBe(false);
  });

  test('with content it asks first, holding no lock, and Cancel changes nothing', async () => {
    const wsl = fakeWsl({ '--set-version': fail(), ...CONTENT });
    const t = repairDeps(wsl, { confirm: async () => (expect(t.lock.held).toBe(false), false) });
    expect(await repairWsl1(t.deps)).toEqual({ result: 'cancelled' });
    expect(ops(wsl.calls)).toEqual(['--set-version', 'find']);
    expect(t.lock.held).toBe(false);
  });

  test('a read of the data that fails counts as content, so the person is asked', async () => {
    const wsl = fakeWsl({ '--set-version': fail(), find: { code: 2, stdout: '', stderr: 'I/O error' } });
    const t = repairDeps(wsl, { confirm: async () => false });
    expect((await repairWsl1(t.deps)).result).toBe('cancelled');
  });

  test('on the login fallback the prompt adds Sign in for Crew', async () => {
    const t = repairDeps(fakeWsl({ '--set-version': fail(), ...CONTENT }), { loginFallback: true, confirm: async () => false });
    let asked = '';
    t.deps.confirm = async (p) => ((asked = p), false);
    await repairWsl1(t.deps);
    expect(asked).toBe(REPAIR_PROMPT_LOGIN);
  });

  test('Continue: free space, export, unregister, import of the export', async () => {
    const wsl = fakeWsl({ '--set-version': fail(), ...CONTENT });
    const t = repairDeps(wsl);
    expect(await repairWsl1(t.deps)).toEqual({ result: 'restored' });
    expect(t.prompts).toEqual([REPAIR_PROMPT]);
    expect(ops(wsl.calls)).toEqual(['--set-version', 'find', '--export', '--unregister', '--import']);
    const backup = 'C:\\L\\Bodhilander\\crew\\backup\\BodhiCrew-2026-11-27.tar';
    expect(wsl.calls[2]).toEqual(['--export', DISTRO, backup]);
    expect(wsl.calls[4]).toEqual(['--import', DISTRO, t.deps.installDir, backup, '--version', '2']);
    expect(t.heldAt['--export']).toBe(true);
    expect(t.lock.held).toBe(false);
  });

  test('short free space stops before the export', async () => {
    const wsl = fakeWsl({ '--set-version': fail(), ...CONTENT });
    const t = repairDeps(wsl, { freeBytes: async () => 15, distroUsedBytes: async () => 10 });
    const out = await repairWsl1(t.deps);
    expect(out.result).toBe('short-space');
    expect(out).toMatchObject({ needBytes: 5 });
    expect(ops(wsl.calls)).toEqual(['--set-version', 'find']);
    expect(t.lock.held).toBe(false);
  });

  test('a failed export unregisters nothing', async () => {
    const wsl = fakeWsl({ '--set-version': fail(), ...CONTENT, '--export': fail('disk full') });
    const t = repairDeps(wsl);
    expect((await repairWsl1(t.deps)).result).toBe('export-failed');
    expect(wsl.calls.some((c) => c[0] === '--unregister')).toBe(false);
    expect(t.lock.held).toBe(false);
  });

  test('the export not importing falls back to the fresh image and names the copy', async () => {
    const wsl = fakeWsl({ '--set-version': fail(), ...CONTENT, '--import': (a) => (a.includes('C:\\dl\\rootfs.tar.gz') ? ok() : fail()) });
    const t = repairDeps(wsl);
    const out = await repairWsl1(t.deps);
    expect(out.result).toBe('fallback');
    expect(out).toMatchObject({ backup: 'C:\\L\\Bodhilander\\crew\\backup\\BodhiCrew-2026-11-27.tar' });
    expect(t.lock.held).toBe(false);
  });

  test('a backup of the same day gets its own name', async () => {
    const wsl = fakeWsl({ '--set-version': fail(), ...CONTENT });
    const t = repairDeps(wsl, { exists: (f) => f.endsWith('BodhiCrew-2026-11-27.tar') });
    await repairWsl1(t.deps);
    expect(wsl.calls[2][2]).toBe('C:\\L\\Bodhilander\\crew\\backup\\BodhiCrew-2026-11-27-2.tar');
  });

  test('a second Repair while one holds the lock is refused and changes nothing more', async () => {
    const wsl = fakeWsl({ '--set-version': fail(), ...EMPTY });
    const t = repairDeps(wsl);
    const release = t.lock.tryAcquire();
    expect((await repairWsl1(t.deps)).result).toBe('busy');
    expect(wsl.calls.some((c) => c[0] === '--unregister')).toBe(false);
    release?.();
  });

  test('an error mid-Repair still releases the lock and deletes the download', async () => {
    const wsl = fakeWsl({ '--set-version': fail(), ...CONTENT });
    const t = repairDeps(wsl, { distroUsedBytes: async () => Promise.reject(new Error('df failed')) });
    expect((await repairWsl1(t.deps)).result).toBe('failed');
    expect(t.lock.held).toBe(false);
    expect(t.removed).toContain('C:\\dl\\rootfs.tar.gz');
  });

  test('no Repair command names any distro but BodhiCrew', async () => {
    const wsl = fakeWsl({ '--set-version': fail(), ...CONTENT });
    await repairWsl1(repairDeps(wsl).deps);
    for (const c of wsl.calls) expect(c.filter((a) => /^[A-Z][\w.-]+$/.test(a) && a !== DISTRO)).toEqual([]);
  });
});
