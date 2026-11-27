import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RUN_DIR_TRIES, RunDirCollision, SocketRootError, ensureSocketRoot, makeRunDir, newRunToken, removeRunDir, runDirName, socketPath, socketRoot, tokenMatches,
} from '../sockets';

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

describe('the socket root', () => {
  test('is made 0700 when missing, and passes when it is a 0700 directory of ours', () => {
    const root = path.join(tmp(), 'cr');
    ensureSocketRoot(root, uid);
    expect(fs.lstatSync(root).mode & 0o777).toBe(0o700);
    expect(() => ensureSocketRoot(root, uid)).not.toThrow();
  });

  test('a wrong mode, a symlink or another owner stops every run', () => {
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
  test('two runs get different directories, and a taken name gets a longer one', () => {
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
