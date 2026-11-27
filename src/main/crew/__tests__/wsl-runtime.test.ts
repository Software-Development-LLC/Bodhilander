import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));
const { FileTmpRecords, realWslExec, shippedFiles, createWindowsCrew } = await import('../wsl-runtime');
const { WSL1_MESSAGE } = await import('../wsl');
const { IMAGE_UNAVAILABLE } = await import('../artifacts');
import { crewDb } from './crew-db';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-wslrt-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const hasNode = Bun.which('node') !== null;

describe('Crew on Windows, as the main process runs it', () => {
  test('TMPDIR names survive a restart in their file, and are removed one by one', () => {
    const file = path.join(tmp(), 'crew', 'wsl-tmp.json');
    const a = new FileTmpRecords(file);
    a.add('n1');
    a.add('n2');
    a.add('n1');
    expect(new FileTmpRecords(file).list()).toEqual(['n1', 'n2']);
    a.remove('n1');
    expect(new FileTmpRecords(file).list()).toEqual(['n2']);
    fs.writeFileSync(file, 'not json');
    expect(a.list()).toEqual([]);
  });

  test.skipIf(!hasNode)('the exec writes stdin, reads both streams, and kills on its timeout', async () => {
    const exec = realWslExec('node');
    const r = await exec(['-e', 'process.stdin.on("data",d=>process.stdout.write(String(d).toUpperCase()));process.stderr.write("e")'], { input: 'hi' });
    expect(r).toMatchObject({ code: 0, stdout: 'HI', stderr: 'e', timedOut: false });
    const slow = await exec(['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 100 });
    expect(slow.timedOut).toBe(true);
  });

  test('a build without the Node or claude bundle installs nothing it lacks, and always ships the helpers', () => {
    const dir = tmp();
    const files = shippedFiles({ dir, relayScript: '/r/crew-mcp.js', shimDir: '/s' }, { node: { file: 'node.tar.xz' } } as never);
    expect(files.nodeTarball).toBeNull();
    expect(files.claudePackage).toBeNull();
    expect(files.helpers?.map((h) => h.to)).toEqual([
      '/home/crew/.bodhilander/crew/bin/crew-mcp.js',
      '/home/crew/.bodhilander/crew/bin/gh-shim/gh-shim.js',
      '/home/crew/.bodhilander/crew/bin/gh-shim/gh',
    ]);
  });

  test('a check that throws holds the run for setup, and the next run checks again', async () => {
    const dir = tmp();
    fs.copyFileSync(path.join(__dirname, '..', '..', '..', '..', 'resources', 'crew-agent', 'versions.json'), path.join(dir, 'versions.json'));
    const audits: string[] = [];
    let sweeps = 0;
    const { db } = crewDb();
    const crew = createWindowsCrew({
      db, signIn: {} as never, accounts: () => [], host: {} as never, gateway: {} as never, broker: () => null, tools: () => ({}) as never, repos: () => [],
      onLost: () => {}, handbook: () => '', skills: () => [], timeZone: () => null, audit: (e) => void audits.push(e), openExternal: () => {}, belongsTo: () => false,
      resources: { dir, relayScript: 'r', shimDir: 's' }, recordsFile: path.join(dir, 'rec.json'), linked: () => true, artifactHub: () => null, crewDir: dir, onRepaired: async () => {},
      exec: async (args) => {
        if (args.join(' ').includes('find /tmp/crt-1000')) sweeps++;
        throw new Error('getent passwd failed');
      },
    });
    expect(await crew.windows.gate()).toBe('held:setup');
    expect(await crew.windows.gate()).toBe('held:setup');
    expect(sweeps).toBe(2);
    expect(audits.filter((e) => e === 'windows-check-failed')).toHaveLength(2);
  });

  test("Repair on WSL1 refuses before changing anything while the image's SHA-256 is a placeholder", async () => {
    const dir = tmp();
    fs.copyFileSync(path.join(__dirname, '..', '..', '..', '..', 'resources', 'crew-agent', 'versions.json'), path.join(dir, 'versions.json'));
    const calls: string[] = [];
    const { db } = crewDb();
    const crew = createWindowsCrew({
      db, signIn: { mode: () => 'token' } as never, accounts: () => [], host: {} as never, gateway: {} as never, broker: () => null, tools: () => ({}) as never, repos: () => [],
      onLost: () => {}, handbook: () => '', skills: () => [], timeZone: () => null, audit: () => {}, openExternal: () => {}, belongsTo: () => false,
      resources: { dir, relayScript: 'r', shimDir: 's' }, recordsFile: path.join(dir, 'rec.json'), linked: () => true, artifactHub: () => null, crewDir: dir, onRepaired: async () => {},
      exec: async (args) => (calls.push(args.join(' ')), { code: 0, stdout: '  NAME       STATE    VERSION\n* BodhiCrew  Stopped  1\n', stderr: '' }),
    });
    expect(await crew.setup.state()).toEqual({ state: 'wsl1', message: WSL1_MESSAGE });
    expect(await crew.setup.repair(true)).toEqual({ ok: false, message: IMAGE_UNAVAILABLE, repair: true });
    expect(calls.every((c) => c === '-l -v')).toBe(true);
    expect(await crew.setup.setup(() => {})).toMatchObject({ ok: false });
    expect(calls.some((c) => c.includes('--import') || c.includes('--unregister') || c.includes('--set-version'))).toBe(false);
  });

  test('the first run sweeps and checks once, and runs are held until the check passes', async () => {
    const dir = tmp();
    fs.copyFileSync(path.join(__dirname, '..', '..', '..', '..', 'resources', 'crew-agent', 'versions.json'), path.join(dir, 'versions.json'));
    const calls: string[] = [];
    const { db } = crewDb();
    const crew = createWindowsCrew({
      db, signIn: {} as never, accounts: () => [], host: {} as never, gateway: {} as never, broker: () => null, tools: () => ({}) as never, repos: () => [],
      onLost: () => {}, handbook: () => '', skills: () => [], timeZone: () => null, audit: () => {}, openExternal: () => {}, belongsTo: () => false,
      resources: { dir, relayScript: 'r', shimDir: 's' }, recordsFile: path.join(dir, 'rec.json'), linked: () => true, artifactHub: () => null, crewDir: dir, onRepaired: async () => {},
      exec: async (args) => (calls.push(args.join(' ')), { code: 1, stdout: '', stderr: '' }),
    });
    expect(calls).toEqual([]);
    expect(await crew.windows.gate()).toBe('held:setup');
    expect(calls[0]).toContain('find /tmp/crt-1000');
    const sweeps = calls.filter((c) => c.includes('find /tmp/crt-1000')).length;
    expect(await crew.windows.gate()).toBe('held:setup');
    expect(calls.filter((c) => c.includes('find /tmp/crt-1000')).length).toBe(sweeps);
  });
});
