import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RUN_DIR_TRIES, RunDirCollision, SocketRootError, ensureSocketRoot, makeRunDir, newRunToken, removeRunDir, runDirName, sweepRunDirs, socketPath, socketRoot, tokenMatches,
} from '../sockets';

// Runs inside WSL2 on Windows, never natively, so native Windows CI skips it.
const posixOnly = test.skipIf(process.platform === 'win32');

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crsock-'));
  made.push(d);
  return d;
};
const uid = process.getuid?.() ?? 0;

describe('sweeping run dirs at start', () => {
  test('every run dir left in an owned root is removed, and a root owned by someone else is left alone', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'ABCDEFGH'));
    fs.writeFileSync(path.join(root, 'ABCDEFGH', 'g.sock'), '');
    fs.mkdirSync(path.join(root, 'IJKLMNOP'));
    expect(sweepRunDirs(root, uid)).toBe(2);
    expect(fs.readdirSync(root)).toEqual([]);
    fs.mkdirSync(path.join(root, 'QRSTUVWX'));
    expect(sweepRunDirs(root, uid + 1)).toBe(0);
    expect(fs.readdirSync(root)).toEqual(['QRSTUVWX']);
    expect(sweepRunDirs(path.join(root, 'missing'), uid)).toBe(0);
  });
});

describe('the socket root', () => {
  posixOnly('is made 0700 when missing, and passes when it is a 0700 directory of ours', () => {
    const root = path.join(tmp(), 'cr');
    ensureSocketRoot(root, uid);
    expect(fs.lstatSync(root).mode & 0o777).toBe(0o700);
    expect(() => ensureSocketRoot(root, uid)).not.toThrow();
  });

  posixOnly('a wrong mode, a symlink or another owner stops every run', () => {
    const base = tmp();
    const loose = path.join(base, 'loose');
    fs.mkdirSync(loose, { mode: 0o755 });
    fs.chmodSync(loose, 0o755);
    expect(() => ensureSocketRoot(loose, uid)).toThrow(SocketRootError);
    try {
      ensureSocketRoot(loose, uid);
    } catch (err) {
      expect((err as SocketRootError).observed).toEqual({ type: 'directory', uid, mode: '755' });
    }
    const link = path.join(base, 'link');
    fs.symlinkSync(loose, link);
    expect(() => ensureSocketRoot(link, uid)).toThrow(SocketRootError);
    const mine = path.join(base, 'mine');
    ensureSocketRoot(mine, uid);
    expect(() => ensureSocketRoot(mine, uid + 1)).toThrow(SocketRootError);
  });
});

describe('run directories', () => {
  posixOnly('two runs get different directories, and a taken name gets a longer one', () => {
    const root = tmp();
    const a = makeRunDir(root, 'run-a');
    const b = makeRunDir(root, 'run-b');
    expect(a).not.toBe(b);
    expect(path.basename(a)).toBe(runDirName('run-a'));
    expect(runDirName('run-a')).toMatch(/^[a-z2-7]{8}$/);
    const again = makeRunDir(root, 'run-a', fs, () => 0);
    expect(path.basename(again)).toBe(`${runDirName('run-a')}a`);
    expect(fs.lstatSync(again).mode & 0o777).toBe(0o700);
    removeRunDir(a);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(again)).toBe(true);
  });

  test('a name taken on every try starts nothing', () => {
    let tries = 0;
    const taken = {
      ...fs,
      mkdirSync: () => {
        tries += 1;
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      },
    } as unknown as typeof fs;
    expect(() => makeRunDir('/r', 'run', taken)).toThrow(RunDirCollision);
    expect(tries).toBe(RUN_DIR_TRIES);
  });

  test('socket paths fit the sun_path limit, and a longer one is refused', () => {
    const p = socketPath(path.join(socketRoot(501), `${runDirName('x')}abc`), 'github');
    expect(Buffer.byteLength(p)).toBeLessThan(104);
    expect(() => socketPath(`/${'d'.repeat(100)}`, 'github')).toThrow(/sun_path/);
  });

  test('a connection must present the run token exactly', () => {
    const token = newRunToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token.slice(1), token)).toBe(false);
    expect(tokenMatches(newRunToken(), token)).toBe(false);
  });
});

describe('the per-run TMPDIR inside BodhiCrew', () => {
  const s = require('../sockets') as typeof import('../sockets');
  const name = '0123456789abcdef0123456789abcdef';
  const records = () => {
    const set = new Set<string>();
    const log: string[] = [];
    return { set, log, add: (n: string) => (log.push(`add ${n}`), set.add(n)) && undefined, remove: (n: string) => void (log.push(`rm ${n}`), set.delete(n)), list: () => [...set] };
  };
  const sh = (stdout: string, scripts: string[] = []) => async (script: string) => (scripts.push(script), { code: 0, stdout, stderr: '' });

  test('names are 128-bit random, never derived from the run id', () => {
    expect(s.newTmpName()).toMatch(/^[0-9a-f]{32}$/);
    expect(s.newTmpName()).not.toBe(s.newTmpName());
  });

  test('a good parent gets an exclusive mkdir, recorded before it is made', async () => {
    const r = records();
    const scripts: string[] = [];
    const dir = await s.makeWslTmpDir(sh('PARENT directory|1000|300\nMADE\n', scripts), 1000, r, name);
    expect(dir).toBe(`/tmp/crt-1000/${name}`);
    expect(r.log).toEqual([`add ${name}`]);
    expect(scripts[0]).toContain(`mkdir -m 0700 "$p/${name}"`);
    expect(scripts[0]).not.toContain('mkdir -p');
  });

  test('a symlink, another owner or a mode but 0300 holds, naming what was seen', async () => {
    for (const [line, observed] of [
      ['PARENT symbolic link|1000|777', { type: 'symlink', uid: 1000, mode: '777' }],
      ['PARENT directory|0|300', { type: 'directory', uid: 0, mode: '300' }],
      ['PARENT directory|1000|700', { type: 'directory', uid: 1000, mode: '700' }],
    ] as const) {
      const r = records();
      const err = await s.makeWslTmpDir(sh(`${line}\n`), 1000, r, name).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(s.TmpParentError);
      expect(err).toBeInstanceOf(s.SocketRootError);
      expect((err as InstanceType<typeof s.TmpParentError>).observed).toEqual(observed);
      expect(r.list()).toEqual([]);
    }
  });

  test('a good parent where the mkdir fails is a collision, not a repair', async () => {
    const err = await s.makeWslTmpDir(sh('PARENT directory|1000|300\n'), 1000, records(), name).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(s.RunDirCollision);
  });

  test('the parent is made only when missing, and never via a followed link', () => {
    const script = s.makeTmpDirScript(1000, name);
    expect(script).toContain('if [ ! -e "$p" ] && [ ! -L "$p" ]; then mkdir "$p" && chmod 0300 "$p"; fi');
    expect(() => s.makeTmpDirScript(1000, '../x')).toThrow();
  });

  test('Repair and the start sweep act on the parent only', () => {
    expect(s.repairTmpParentScript(1000)).toBe('rm -rf /tmp/crt-1000 && mkdir /tmp/crt-1000 && chown 1000:1000 /tmp/crt-1000 && chmod 0300 /tmp/crt-1000');
    expect(s.sweepTmpParentScript(1000)).toContain('find /tmp/crt-1000 -mindepth 1 -maxdepth 1 -exec rm -rf {} +');
  });

  test('recorded orphans are removed; live ones stay', async () => {
    const r = records();
    const other = 'f'.repeat(32);
    r.add(name);
    r.add(other);
    const scripts: string[] = [];
    await s.removeTmpOrphans(sh('', scripts), 1000, r, new Set([other]));
    expect(r.list()).toEqual([other]);
    expect(scripts).toEqual([`rm -rf /tmp/crt-1000/${name}`]);
  });
});
