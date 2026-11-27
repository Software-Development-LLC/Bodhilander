#!/usr/bin/env node
// crew-agent: started per run inside BodhiCrew by Bodhilander's main process,
// over `wsl.exe -d BodhiCrew --`. It opens no TCP port and keeps no time.
//   serve     the run's gateway sockets, relayed over stdio as JSON lines
//   exec-run  starts claude with the Crew token on descriptor 3
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

export const VERSION = '1.0.0';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const RUN_DIR_TRIES = 4;

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

function checkRoot(root, uid) {
  let st;
  try {
    st = fs.lstatSync(root);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(root, { mode: 0o700 });
    fs.chmodSync(root, 0o700);
    st = fs.lstatSync(root);
  }
  const mode = st.mode & 0o777;
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid || mode !== 0o700) {
    const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'other';
    return { type, uid: st.uid, mode: mode.toString(8) };
  }
  return null;
}

function makeRunDir(root, name) {
  for (let i = 0; i < RUN_DIR_TRIES; i += 1) {
    const dir = path.join(root, name);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      return dir;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      name += BASE32[randomInt(32)];
    }
  }
  return null;
}

export async function serve(input = process.stdin, root = null) {
  send({ t: 'hello', version: VERSION });
  const conns = new Map();
  const servers = [];
  let dir = null;
  let next = 0;
  const cleanup = () => {
    for (const s of servers) s.close();
    for (const c of conns.values()) c.destroy();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  };
  const lines = createInterface({ input });
  lines.on('line', (line) => {
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      return;
    }
    if (f.t === 'serve' && !dir) {
      const base = root ?? `/tmp/cr-${f.uid}`;
      const bad = checkRoot(base, f.uid);
      if (bad) return send({ t: 'error', code: 'socket-root', observed: bad });
      dir = makeRunDir(base, f.name);
      if (!dir) return send({ t: 'error', code: 'run-dir-collision' });
      const sockets = {};
      let pending = f.sockets.length;
      for (const sock of f.sockets) {
        const p = path.join(dir, `${sock}.sock`);
        const server = net.createServer((conn) => {
          const id = (next += 1);
          conns.set(id, conn);
          send({ t: 'open', conn: id, sock });
          conn.on('data', (b) => send({ t: 'data', conn: id, b64: b.toString('base64') }));
          conn.on('end', () => send({ t: 'end', conn: id }));
          conn.on('error', () => conn.destroy());
          conn.on('close', () => conns.delete(id));
        });
        servers.push(server);
        server.listen(p, () => {
          fs.chmodSync(p, 0o600);
          sockets[sock] = p;
          if ((pending -= 1) === 0) send({ t: 'ready', dir, sockets });
        });
      }
    } else if (f.t === 'data') {
      conns.get(f.conn)?.write(Buffer.from(f.b64, 'base64'));
    } else if (f.t === 'end') {
      conns.get(f.conn)?.end();
    }
  });
  await new Promise((resolve) => lines.on('close', resolve));
  cleanup();
}

/** Reads one line from the stream, leaving the rest of it unread. */
function readLine(stream) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const cut = buf.indexOf(10);
      if (cut < 0) return;
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.pause();
      const rest = buf.subarray(cut + 1);
      if (rest.length) stream.unshift(rest);
      resolve(buf.subarray(0, cut).toString('utf8'));
    };
    const onEnd = () => reject(new Error('stdin ended before the header'));
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.resume();
  });
}

/** Line one is the Crew token (empty on the login fallback), line two the run as JSON, then the prompt. */
export async function execRun(input = process.stdin) {
  const token = await readLine(input);
  const run = JSON.parse(await readLine(input));
  const stdio = ['pipe', 'inherit', 'inherit', token ? 'pipe' : 'ignore'];
  const child = spawn(run.argv[0], run.argv.slice(1), { cwd: run.cwd, env: run.env, stdio });
  if (token) {
    child.stdio[3].end(`${token}\n`);
  }
  input.pipe(child.stdin);
  input.resume();
  child.stdin.on('error', () => {});
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  return new Promise((resolve) => child.on('close', (code, signal) => resolve(code ?? (signal ? 128 + 15 : 1))));
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  const mode = process.argv[2];
  if (mode === '--version') {
    process.stdout.write(`${VERSION}\n`);
  } else if (mode === 'serve') {
    serve().then(() => process.exit(0));
  } else if (mode === 'exec-run') {
    execRun().then((code) => process.exit(code), (err) => {
      process.stderr.write(`crew-agent: ${err.message}\n`);
      process.exit(70);
    });
  } else {
    process.stderr.write('usage: crew-agent --version | serve | exec-run\n');
    process.exit(64);
  }
}
