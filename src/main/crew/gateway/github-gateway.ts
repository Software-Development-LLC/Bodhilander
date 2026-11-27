/**
 * The read-only GitHub gateway. A run's `gh` shim connects to its per-run
 * socket with the run token; the gateway runs a read command with a read
 * token the Hub minted for the job's requester, held in memory and reused
 * for at most 5 minutes after its mint. Every write is refused.
 */
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { writeAudit } from '../audit';
import type { TokenFrame } from '../protocol';
import { tokenMatches } from '../run/sockets';

export const TOKEN_REUSE_MS = 5 * 60_000;
export const TOKEN_WAIT_MS = 20_000;
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
export const WRITE_MESSAGE = 'GitHub writes arrive in phase 2. This gh command was not run.';

const READS: Record<string, readonly string[]> = {
  issue: ['list', 'view', 'status'],
  pr: ['list', 'view', 'diff', 'checks', 'status'],
  repo: ['view'],
  release: ['list', 'view'],
  run: ['list', 'view'],
  search: ['issues', 'prs', 'code', 'commits'],
  label: ['list'],
};
const API_WRITE_FLAGS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);
const REPO_FLAGS = new Set(['-R', '--repo']);

export type GhPlan = { kind: 'read'; args: string[] } | { kind: 'write' } | { kind: 'refused'; why: string };

function flagValue(args: string[], names: Set<string>): { value: string | null; index: number } {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (names.has(a)) return { value: args[i + 1] ?? '', index: i };
    for (const n of names) if (n.startsWith('--') && a.startsWith(`${n}=`)) return { value: a.slice(n.length + 1), index: i };
  }
  return { value: null, index: -1 };
}

function planApi(rest: string[], repos: readonly string[]): GhPlan {
  if (rest.some((a) => API_WRITE_FLAGS.has(a) || [...API_WRITE_FLAGS].some((f) => f.startsWith('--') && a.startsWith(`${f}=`)))) return { kind: 'write' };
  const method = flagValue(rest, new Set(['-X', '--method'])).value;
  if (method !== null && method.toUpperCase() !== 'GET') return { kind: 'write' };
  const endpoint = rest.find((a) => !a.startsWith('-') && /^\/?repos\//.test(a)) ?? rest.find((a) => !a.startsWith('-'));
  const m = endpoint ? /^\/?repos\/([^/]+\/[^/?]+)/.exec(endpoint) : null;
  if (!m) return { kind: 'refused', why: 'gh api reaches only repos/<owner>/<repo>/… of this hire.' };
  if (!repos.includes(m[1].toLowerCase())) return { kind: 'refused', why: `${m[1]} is not one of this hire's repos.` };
  return { kind: 'read', args: ['api', ...rest] };
}

/** What a run's `gh` argv may do. Repos are lowercase owner/name. */
export function planGh(argv: string[], repos: readonly string[]): GhPlan {
  const [group, sub, ...rest] = argv;
  if (group === 'api') return planApi(argv.slice(1), repos);
  if (!group || !(group in READS)) return { kind: 'write' };
  if (!sub || !READS[group].includes(sub)) return { kind: 'write' };
  if (rest.some((a) => a === '-w' || a === '--web')) return { kind: 'refused', why: 'A run cannot open a browser.' };
  const repo = flagValue(rest, REPO_FLAGS);
  if (repo.value !== null && !repos.includes(repo.value.toLowerCase())) return { kind: 'refused', why: `${repo.value} is not one of this hire's repos.` };
  if (group === 'search') {
    if (rest.some((a) => a === '--owner' || a.startsWith('--owner='))) return { kind: 'refused', why: 'Search names repos with --repo, never --owner.' };
    return { kind: 'read', args: repo.value === null ? [...argv, ...repos.flatMap((r) => ['--repo', r])] : argv };
  }
  if (repo.value !== null) return { kind: 'read', args: argv };
  if (repos.length !== 1) return { kind: 'refused', why: `Name the repo with -R: one of ${repos.join(', ')}.` };
  return { kind: 'read', args: [...argv, '-R', repos[0]] };
}

export interface GatewayRun {
  jobId: string;
  hireId: string;
  requestedBy: string;
  repos: string[];
  token: string;
}

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GatewayDeps {
  db: Database.Database;
  requestToken(jobId: string, id: string, requestedBy: string, repos: string[]): boolean;
  run(args: string[], env: Record<string, string>): Promise<GhResult>;
  now?(): number;
  newId?(): string;
  tokenWaitMs?: number;
}

interface Cached {
  token: string;
  mintedAt: number;
  repos: string[];
}

interface Pending {
  resolve(token: string | null): void;
  timer: NodeJS.Timeout;
}

export class GithubGateway {
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Pending>();
  private readonly servers = new Map<string, net.Server>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: GatewayDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /** Never across requesters: the key is the requester and the exact repo set. */
  private key(requestedBy: string, repos: string[]): string {
    return `${requestedBy}\n${[...repos].sort().join(',')}`;
  }

  onToken(frame: TokenFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    pending.resolve(frame.token);
  }

  onRefused(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(null);
  }

  async tokenFor(run: GatewayRun): Promise<string | null> {
    const key = this.key(run.requestedBy, run.repos);
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.mintedAt < TOKEN_REUSE_MS) return cached.token;
    this.cache.delete(key);
    const id = this.newId();
    const token = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, this.deps.tokenWaitMs ?? TOKEN_WAIT_MS);
      this.pending.set(id, { resolve, timer });
      if (!this.deps.requestToken(run.jobId, id, run.requestedBy, run.repos)) this.onRefused(id);
    });
    if (token !== null) this.cache.set(key, { token, mintedAt: this.now(), repos: run.repos });
    return token;
  }

  async handle(run: GatewayRun, request: { token?: unknown; args?: unknown }): Promise<GhResult> {
    if (typeof request.token !== 'string' || !tokenMatches(request.token, run.token)) {
      writeAudit(this.deps.db, run.hireId, 'gateway-refused', { jobId: run.jobId, reason: 'token' });
      return { code: 1, stdout: '', stderr: 'refused\n' };
    }
    const args = Array.isArray(request.args) && request.args.every((a) => typeof a === 'string') ? (request.args as string[]) : [];
    const plan = planGh(args, run.repos);
    if (plan.kind === 'write') {
      writeAudit(this.deps.db, run.hireId, 'gh-write-refused', { jobId: run.jobId, command: args.slice(0, 2).join(' ') });
      return { code: 1, stdout: '', stderr: `${WRITE_MESSAGE}\n` };
    }
    if (plan.kind === 'refused') return { code: 1, stdout: '', stderr: `${plan.why}\n` };
    const ghToken = await this.tokenFor(run);
    if (ghToken === null) return { code: 1, stdout: '', stderr: 'No GitHub read access for this request right now.\n' };
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-gh-'));
    try {
      return await this.deps.run(plan.args, { GH_TOKEN: ghToken, GH_CONFIG_DIR: configDir, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', PATH: process.env.PATH ?? '' });
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }

  /** One listener per run, on its 0600 socket. */
  listen(socketPath: string, run: GatewayRun): Promise<void> {
    const server = net.createServer((conn) => {
      let buffered = '';
      conn.setEncoding('utf8');
      conn.on('error', () => conn.destroy());
      conn.on('data', (chunk: string) => {
        buffered += chunk;
        if (buffered.length > 1024 * 1024) return conn.destroy();
        const cut = buffered.indexOf('\n');
        if (cut < 0) return;
        let request: { token?: unknown; args?: unknown } = {};
        try {
          request = JSON.parse(buffered.slice(0, cut)) as typeof request;
        } catch {
          request = {};
        }
        buffered = '';
        void this.handle(run, request).then((r) => conn.end(`${JSON.stringify(r)}\n`));
      });
    });
    this.servers.set(run.jobId, server);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        fs.chmodSync(socketPath, 0o600);
        resolve();
      });
    });
  }

  close(jobId: string): void {
    this.servers.get(jobId)?.close();
    this.servers.delete(jobId);
  }

  stop(): void {
    for (const id of [...this.servers.keys()]) this.close(id);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
      this.pending.delete(id);
    }
    this.cache.clear();
  }
}

export function runGh(ghPath: string): GatewayDeps['run'] {
  return (args, env) =>
    new Promise((resolve) => {
      execFile(ghPath, args, { env, maxBuffer: MAX_OUTPUT_BYTES, timeout: 60_000 }, (err, stdout, stderr) => {
        const exit = (err as { code?: unknown } | null)?.code;
        let code = 0;
        if (err) code = typeof exit === 'number' ? exit : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}
