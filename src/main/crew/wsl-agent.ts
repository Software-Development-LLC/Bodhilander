/**
 * The main-process side of `crew-agent`, one per run inside BodhiCrew: it relays the run's
 * gateway sockets here, and `exec-run` puts the Crew token on descriptor 3, never in argv or WSLENV.
 */
import type { Duplex } from 'stream';
import type { PreparedRun } from './run/loop';
import { RunDirCollision, SocketRootError } from './run/sockets';
import { DISTRO } from './wsl';
import { CREW_AGENT, installLock, type InstallLock } from './wsl-setup';

export const WSL_EXE = 'wsl.exe';
/** What wsl.exe itself needs; WSLENV is never passed, so nothing crosses into the distro by environment. */
const WINDOWS_KEPT = ['SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'PATH', 'Path', 'USERPROFILE', 'LOCALAPPDATA', 'TEMP', 'TMP'];

export function windowsEnv(parent: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of WINDOWS_KEPT) if (parent[k] !== undefined) env[k] = parent[k];
  return env;
}

export class AgentVersionError extends Error {
  constructor(readonly got: string | null) {
    super(`crew-agent version mismatch (${got ?? 'no handshake'})`);
  }
}

export class AgentClosed extends Error {
  constructor() {
    super('crew-agent closed');
  }
}

export function agentServeArgs(): string[] {
  return ['-d', DISTRO, '-u', 'crew', '--', CREW_AGENT, 'serve'];
}

export function execRunArgs(): string[] {
  return ['-d', DISTRO, '-u', 'crew', '--', CREW_AGENT, 'exec-run'];
}

/** What exec-run reads: the token line (empty on the login fallback), the run as JSON, then the prompt. */
export function execRunInput(token: string | null, run: { cwd: string; env: Record<string, string>; argv: string[] }, prompt: string): string {
  if (token !== null && /[\r\n]/.test(token)) throw new Error('a Crew token cannot hold a newline');
  return `${token ?? ''}\n${JSON.stringify(run)}\n${prompt}`;
}

/** A run prepared with posix paths inside BodhiCrew, launched from Windows through exec-run. */
export function wslLaunch(run: PreparedRun): PreparedRun {
  return {
    ...run,
    command: WSL_EXE,
    args: execRunArgs(),
    cwd: process.env.SystemRoot ?? 'C:\\Windows',
    env: windowsEnv(),
    input: execRunInput(run.token, { cwd: run.cwd, env: run.env, argv: [run.command, ...run.args] }, run.input),
    token: null,
  };
}

/** The agent process as the session sees it: lines out, lines in, and its end. */
export interface AgentChild {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
  kill(): void;
}

export interface AgentFrame {
  t: string;
  [k: string]: unknown;
}

export interface Served {
  dir: string;
  sockets: Record<string, string>;
}

export interface SessionOptions {
  version: string;
  uid: number;
  name: string;
  sockets: string[];
  /** Served beside the run dir, outside anything the run's sandbox can read. */
  privateSockets?: string[];
  now(): number;
  /** A connection to the main-process gateway for socket `sock`. */
  connect(sock: string): Duplex;
  /** The stdio closed mid-run: the run is interrupted and its job re-queued. */
  onLost(): void;
  handshakeMs?: number;
}

export class AgentSession {
  private readonly conns = new Map<number, Duplex>();
  private served = false;
  private closed = false;

  constructor(private readonly child: AgentChild, private readonly opts: SessionOptions) {}

  start(): Promise<Served> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.child.kill();
        reject(err);
      };
      const timer = setTimeout(() => fail(new AgentVersionError(null)), this.opts.handshakeMs ?? 15_000);
      this.child.onClose(() => {
        this.closed = true;
        clearTimeout(timer);
        for (const c of this.conns.values()) c.destroy();
        this.conns.clear();
        if (!settled) fail(new AgentClosed());
        else if (this.served) this.opts.onLost();
      });
      this.child.onLine((line) => {
        let f: AgentFrame;
        try {
          f = JSON.parse(line) as AgentFrame;
        } catch {
          return;
        }
        if (f.t === 'hello') {
          if (f.version !== this.opts.version) return fail(new AgentVersionError(typeof f.version === 'string' ? f.version : null));
          this.send({ t: 'serve', now: this.opts.now(), uid: this.opts.uid, name: this.opts.name, sockets: this.opts.sockets, private: this.opts.privateSockets ?? [] });
        } else if (f.t === 'ready') {
          clearTimeout(timer);
          settled = true;
          this.served = true;
          resolve({ dir: String(f.dir), sockets: f.sockets as Record<string, string> });
        } else if (f.t === 'error') {
          clearTimeout(timer);
          if (f.code === 'run-dir-collision') fail(new RunDirCollision());
          else fail(new SocketRootError((f.observed as SocketRootError['observed']) ?? { type: 'unknown', uid: null, mode: null }));
        } else if (f.t === 'open') this.open(Number(f.conn), String(f.sock));
        else if (f.t === 'data') this.conns.get(Number(f.conn))?.write(Buffer.from(String(f.b64), 'base64'));
        else if (f.t === 'end') this.conns.get(Number(f.conn))?.end();
      });
    });
  }

  private open(id: number, sock: string): void {
    if (![...this.opts.sockets, ...(this.opts.privateSockets ?? [])].includes(sock)) return this.send({ t: 'end', conn: id });
    const conn = this.opts.connect(sock);
    this.conns.set(id, conn);
    conn.on('data', (b: Buffer) => this.send({ t: 'data', conn: id, b64: Buffer.from(b).toString('base64') }));
    conn.on('end', () => this.send({ t: 'end', conn: id }));
    conn.on('error', () => conn.destroy());
    conn.on('close', () => this.conns.delete(id));
  }

  private send(frame: AgentFrame): void {
    if (!this.closed) this.child.write(`${JSON.stringify(frame)}\n`);
  }

  /** The run ended: the agent removes its directory when its stdin closes. */
  stop(): void {
    this.served = false;
    this.child.kill();
  }
}

export interface StartAgentDeps extends Omit<SessionOptions, 'onLost'> {
  spawn(): AgentChild;
  reinstall(): Promise<boolean>;
  lock?: InstallLock;
  onLost(): void;
}

/** A version mismatch reinstalls under the install lock and retries once; a second one is the caller's held:setup. */
export async function startAgent(deps: StartAgentDeps): Promise<{ session: AgentSession; served: Served }> {
  for (let attempt = 0; ; attempt += 1) {
    const session = new AgentSession(deps.spawn(), deps);
    try {
      return { session, served: await session.start() };
    } catch (err) {
      if (!(err instanceof AgentVersionError) || attempt > 0) throw err;
      if (!(await (deps.lock ?? installLock).run(deps.reinstall))) throw err;
    }
  }
}
