import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Duplex, PassThrough } from 'stream';
import { RunDirCollision, SocketRootError } from '../run/sockets';
import { AgentClosed, AgentVersionError, execRunArgs, execRunInput, startAgent, windowsEnv, wslLaunch, type AgentChild } from '../wsl-agent';
import { InstallLock } from '../wsl-setup';

const AGENT = path.join(__dirname, '../../../../resources/crew-agent/crew-agent.mjs');
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join('/tmp', 'cra-'));
  made.push(d);
  return d;
};

/** A scripted agent: answers the handshake and records what the main process sent it. */
function fakeAgent(version: string, after?: (f: Record<string, unknown>, emit: (o: object) => void) => void) {
  const sent: Array<Record<string, unknown>> = [];
  let onLine: (l: string) => void = () => {};
  let onClose: () => void = () => {};
  const emit = (o: object) => onLine(JSON.stringify(o));
  const child: AgentChild & { close(): void; emit: typeof emit } = {
    write: (l) => {
      const f = JSON.parse(l) as Record<string, unknown>;
      sent.push(f);
      after?.(f, emit);
    },
    onLine: (cb) => {
      onLine = cb;
      queueMicrotask(() => emit({ t: 'hello', version }));
    },
    onClose: (cb) => void (onClose = cb),
    kill: () => onClose(),
    close: () => onClose(),
    emit,
  };
  return { child, sent };
}

const ready = (f: Record<string, unknown>, emit: (o: object) => void) => {
  if (f.t === 'serve') emit({ t: 'ready', dir: `/tmp/cr-1000/${String(f.name)}`, sockets: { gh: `/tmp/cr-1000/${String(f.name)}/gh.sock` } });
};

const base = { version: '1.0.0', uid: 1000, name: 'abcdefgh', sockets: ['gh'], now: () => 42, connect: () => new PassThrough(), handshakeMs: 200 };

describe('the crew-agent handshake', () => {
  test('a matching version serves, and the main process gives it the time', async () => {
    const a = fakeAgent('1.0.0', ready);
    const out = await startAgent({ ...base, spawn: () => a.child, reinstall: async () => true, onLost: () => {} });
    expect(out.served).toEqual({ dir: '/tmp/cr-1000/abcdefgh', sockets: { gh: '/tmp/cr-1000/abcdefgh/gh.sock' } });
    expect(a.sent[0]).toEqual({ t: 'serve', now: 42, uid: 1000, name: 'abcdefgh', sockets: ['gh'], private: [] });
  });

  test('a mismatch reinstalls once and retries; a second mismatch is an error for held:setup', async () => {
    let installs = 0;
    const agents = [fakeAgent('0.9.0'), fakeAgent('1.0.0', ready)];
    await startAgent({ ...base, spawn: () => agents.shift()!.child, reinstall: async () => (installs++, true), onLost: () => {} });
    expect(installs).toBe(1);

    installs = 0;
    const err = await startAgent({ ...base, spawn: () => fakeAgent('0.9.0').child, reinstall: async () => (installs++, true), onLost: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentVersionError);
    expect(installs).toBe(1);
  });

  test('two runs that both see a mismatch share one reinstall', async () => {
    const lock = new InstallLock();
    let installs = 0;
    const reinstall = () => new Promise<boolean>((r) => setTimeout(() => (installs++, r(true)), 10));
    const run = () => {
      const agents = [fakeAgent('0.9.0'), fakeAgent('1.0.0', ready)];
      return startAgent({ ...base, lock, spawn: () => agents.shift()!.child, reinstall, onLost: () => {} });
    };
    await Promise.all([run(), run()]);
    expect(installs).toBe(1);
  });

  test('a bad socket root or a collision comes back as the run errors the loop already holds on', async () => {
    const bad = fakeAgent('1.0.0', (f, emit) => f.t === 'serve' && emit({ t: 'error', code: 'socket-root', observed: { type: 'symlink', uid: 0, mode: '777' } }));
    const e1 = await startAgent({ ...base, spawn: () => bad.child, reinstall: async () => true, onLost: () => {} }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(SocketRootError);
    const col = fakeAgent('1.0.0', (f, emit) => f.t === 'serve' && emit({ t: 'error', code: 'run-dir-collision' }));
    expect(await startAgent({ ...base, spawn: () => col.child, reinstall: async () => true, onLost: () => {} }).catch((e: unknown) => e)).toBeInstanceOf(RunDirCollision);
  });

  test('the stdio closing mid-run interrupts the run; before ready it is an error', async () => {
    let lost = 0;
    const a = fakeAgent('1.0.0', ready);
    await startAgent({ ...base, spawn: () => a.child, reinstall: async () => true, onLost: () => lost++ });
    a.child.close();
    expect(lost).toBe(1);

    const early = fakeAgent('1.0.0', (f) => f.t === 'serve' && queueMicrotask(() => early.child.close()));
    expect(await startAgent({ ...base, spawn: () => early.child, reinstall: async () => true, onLost: () => lost++ }).catch((e: unknown) => e)).toBeInstanceOf(AgentClosed);
    expect(lost).toBe(1);
  });

  test('connections are relayed to the gateway; an unknown socket name is refused', async () => {
    const written: string[] = [];
    const gw = new Duplex({ read() {}, write(c, _e, cb) { written.push(String(c)); cb(); } });
    const a = fakeAgent('1.0.0', ready);
    const opened: string[] = [];
    await startAgent({ ...base, connect: (s) => (opened.push(s), gw), spawn: () => a.child, reinstall: async () => true, onLost: () => {} });
    a.child.emit({ t: 'open', conn: 1, sock: 'approve' });
    expect(opened).toEqual([]);
    expect(a.sent.at(-1)).toEqual({ t: 'end', conn: 1 });
    a.child.emit({ t: 'open', conn: 2, sock: 'gh' });
    a.child.emit({ t: 'data', conn: 2, b64: Buffer.from('{"token":"t"}\n').toString('base64') });
    expect(written).toEqual(['{"token":"t"}\n']);
    gw.push('answer\n');
    await new Promise((r) => setTimeout(r, 5));
    expect(a.sent.at(-1)).toEqual({ t: 'data', conn: 2, b64: Buffer.from('answer\n').toString('base64') });
  });
});

describe('the run launch through exec-run', () => {
  const run = { command: '/home/crew/.bodhilander/crew/bin/claude', args: ['-p', '--settings', '/s.json'], cwd: '/home/crew/h/owner', env: { HOME: '/home/crew', TMPDIR: '/tmp/crt-1000/x' }, input: 'hello', accountId: 'a', sessionId: null, token: 'sk-ant-oat01-secret' };

  test('is wsl.exe into BodhiCrew as crew, with the token only on stdin', () => {
    const l = wslLaunch(run);
    expect(l.command).toBe('wsl.exe');
    expect(l.args).toEqual(execRunArgs());
    expect(l.args).toEqual(['-d', 'BodhiCrew', '-u', 'crew', '--', '/home/crew/.bodhilander/crew/bin/crew-agent', 'exec-run']);
    expect(JSON.stringify([l.args, l.env])).not.toContain('secret');
    expect(l.env).not.toHaveProperty('WSLENV');
    expect(l.token).toBeNull();
    expect(l.input.split('\n')[0]).toBe('sk-ant-oat01-secret');
    expect(JSON.parse(l.input.split('\n')[1])).toEqual({ cwd: run.cwd, env: run.env, argv: [run.command, ...run.args] });
  });

  test('WSLENV and WSL_INTEROP never reach wsl.exe', () => {
    expect(windowsEnv({ SystemRoot: 'C:\\Windows', WSLENV: 'GH_TOKEN/u', WSL_INTEROP: 'x', GH_TOKEN: 'g' })).toEqual({ SystemRoot: 'C:\\Windows' });
  });

  test('a token with a newline is refused', () => {
    expect(() => execRunInput('a\nb', { cwd: '/', env: {}, argv: ['x'] }, '')).toThrow();
  });
});

const hasNode = spawnSync('node', ['--version']).status === 0;

describe.skipIf(!hasNode)('crew-agent itself, under node', () => {
  test('--version matches versions.json', () => {
    const v = JSON.parse(fs.readFileSync(path.join(path.dirname(AGENT), 'versions.json'), 'utf8')).crewAgent.version;
    expect(spawnSync('node', [AGENT, '--version']).stdout.toString().trim()).toBe(v);
  });

  test('exec-run puts the token on descriptor 3 and the prompt on stdin, never in argv or env', async () => {
    const dir = tmp();
    const fake = path.join(dir, 'claude.js');
    fs.writeFileSync(fake, `const fs=require('fs');const tok=fs.readFileSync(3,'utf8');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({tok,stdin:s,argv:process.argv.slice(2),env:process.env.CREW_X,hasTok:JSON.stringify(process.env).includes('oat01')}));process.exit(3)})`);
    const child = spawn('node', [AGENT, 'exec-run'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stdin.end(execRunInput('sk-ant-oat01-abc', { cwd: dir, env: { CREW_X: 'y', PATH: process.env.PATH ?? '' }, argv: ['node', fake, '-p'] }, 'the prompt'));
    const code = await new Promise((r) => child.on('close', r));
    expect(code).toBe(3);
    expect(JSON.parse(out)).toEqual({ tok: 'sk-ant-oat01-abc\n', stdin: 'the prompt', argv: ['-p'], env: 'y', hasTok: false });
  });

  test('serve makes a 0700 run dir with a 0600 socket, relays bytes, and removes the dir when stdin closes', async () => {
    const root = path.join(tmp(), 'cr');
    const child = spawn('node', ['-e', `import(${JSON.stringify(AGENT)}).then(m=>m.serve(process.stdin, ${JSON.stringify(root)}))`], { stdio: ['pipe', 'pipe', 'inherit'] });
    const frames: Array<Record<string, unknown>> = [];
    let buf = '';
    const waitFor = (t: string) => new Promise<Record<string, unknown>>((resolve) => {
      const check = () => {
        const f = frames.find((x) => x.t === t);
        if (f) resolve(f);
        else setTimeout(check, 5);
      };
      check();
    });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    expect((await waitFor('hello')).version).toBe('1.0.0');
    child.stdin.write(`${JSON.stringify({ t: 'serve', now: 1, uid: process.getuid?.() ?? 0, name: 'abcdefgh', sockets: ['gh'], private: ['mcp'] })}\n`);
    const r = await waitFor('ready');
    const sock = (r.sockets as Record<string, string>).gh;
    const mcp = (r.sockets as Record<string, string>).mcp;
    expect(path.dirname(mcp)).toBe(path.join(root, 'p-abcdefgh'));
    expect(path.dirname(mcp).startsWith(`${String(r.dir)}/`)).toBe(false);
    expect(fs.lstatSync(path.dirname(mcp)).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(root).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(String(r.dir)).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(sock).mode & 0o777).toBe(0o600);
    const c = net.connect(sock);
    c.write('ping\n');
    const open = await waitFor('open');
    const data = await waitFor('data');
    expect(Buffer.from(String(data.b64), 'base64').toString()).toBe('ping\n');
    let got = '';
    c.on('data', (d) => (got += d));
    child.stdin.write(`${JSON.stringify({ t: 'data', conn: open.conn, b64: Buffer.from('pong\n').toString('base64') })}\n`);
    await new Promise((res) => setTimeout(res, 50));
    expect(got).toBe('pong\n');
    c.destroy();
    child.stdin.end();
    await new Promise((res) => child.on('close', res));
    expect(fs.existsSync(String(r.dir))).toBe(false);
    expect(fs.existsSync(path.dirname(mcp))).toBe(false);
  });

  test('serve refuses a socket root it does not own at 0700', async () => {
    const root = path.join(tmp(), 'cr');
    fs.mkdirSync(root, { mode: 0o755 });
    fs.chmodSync(root, 0o755);
    const out = spawnSync('node', ['-e', `import(${JSON.stringify(AGENT)}).then(m=>m.serve(process.stdin, ${JSON.stringify(root)}))`], {
      input: `${JSON.stringify({ t: 'serve', now: 1, uid: process.getuid?.() ?? 0, name: 'abcdefgh', sockets: ['gh'] })}\n`,
    });
    const frames = out.stdout.toString().trim().split('\n').map((l) => JSON.parse(l));
    expect(frames[1]).toEqual({ t: 'error', code: 'socket-root', observed: { type: 'directory', uid: process.getuid?.() ?? 0, mode: '755' } });
  });
});
