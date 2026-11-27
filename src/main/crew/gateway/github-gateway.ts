/**
 * The read-only GitHub gateway behind a run's `gh` shim. Reads run with a
 * token the Hub minted for the job's requester, reused for under 5 minutes.
 */
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type Database from 'better-sqlite3';
import log from 'electron-log';
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
const API_VALUE_FLAGS = new Set(['-H', '--header', '-q', '--jq', '-t', '--template', '-p', '--preview', '--cache', '-X', '--method']);
const API_REFUSED_FLAGS = new Set(['--hostname']);
const REPO_FLAGS = new Set(['-R', '--repo']);

export type GhPlan = { kind: 'read'; args: string[] } | { kind: 'write' } | { kind: 'refused'; why: string };

const flagName = (a: string): string => (a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a);

/** Every value given for any of `names`, in order. */
function flagValues(args: string[], names: Set<string>): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (names.has(a)) values.push(args[i + 1] ?? '');
    else if (a.startsWith('--') && a.includes('=') && names.has(flagName(a))) values.push(a.slice(a.indexOf('=') + 1));
  }
  return values;
}

const METHOD_FLAGS = new Set(['-X', '--method']);

function apiFlagPlan(name: string): GhPlan | null {
  if (API_WRITE_FLAGS.has(name)) return { kind: 'write' };
  if (API_REFUSED_FLAGS.has(name)) return { kind: 'refused', why: 'gh api reaches github.com only.' };
  return null;
}

function apiEndpointPlan(positional: string[], repos: readonly string[], rest: string[]): GhPlan {
  const endpoint = positional.length === 1 ? positional[0] : null;
  const m = endpoint && !/\.\.|%|\\/.test(endpoint) ? /^\/?repos\/([^/]+\/[^/?#]+)(?:[/?#]|$)/.exec(endpoint) : null;
  if (!m) return { kind: 'refused', why: 'gh api takes one endpoint, under repos/<owner>/<repo>/ of this hire.' };
  if (!repos.includes(m[1].toLowerCase())) return { kind: 'refused', why: `${m[1]} is not one of this hire's repos.` };
  return { kind: 'read', args: ['api', ...rest] };
}

function planApi(rest: string[], repos: readonly string[]): GhPlan {
  const positional: string[] = [];
  let method: string | null = null;
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    const name = flagName(a);
    const stop = apiFlagPlan(name);
    if (stop) return stop;
    const inline = name !== a;
    if (!a.startsWith('-')) positional.push(a);
    else if (API_VALUE_FLAGS.has(name)) {
      if (METHOD_FLAGS.has(name)) method = inline ? a.slice(a.indexOf('=') + 1) : (rest[i + 1] ?? '');
      if (!inline) i += 1;
    }
    i += 1;
  }
  if (method !== null && method.toUpperCase() !== 'GET') return { kind: 'write' };
  return apiEndpointPlan(positional, repos, rest);
}

/** What a run's `gh` argv may do. Repos are lowercase owner/name. */
const GROUPED_SHORT = /^-[^-].+/;
const SEARCH_SCOPE = /(^|\s)-?(repo|org|user|owner):/i;

export function planGh(argv: string[], repos: readonly string[]): GhPlan {
  if (argv.some((a) => GROUPED_SHORT.test(a))) return { kind: 'refused', why: 'Give each short flag on its own, with its value as the next argument.' };
  const [group, sub, ...rest] = argv;
  if (group === 'api') return planApi(argv.slice(1), repos);
  if (!group || !(group in READS)) return { kind: 'write' };
  if (!sub || !READS[group].includes(sub)) return { kind: 'write' };
  if (rest.some((a) => a === '-w' || a === '--web')) return { kind: 'refused', why: 'A run cannot open a browser.' };
  const named = flagValues(rest, REPO_FLAGS);
  if (named.length > 1) return { kind: 'refused', why: 'Name one repo with -R.' };
  const repo = { value: named[0] ?? null };
  if (repo.value !== null && !repos.includes(repo.value.toLowerCase())) return { kind: 'refused', why: `${repo.value} is not one of this hire's repos.` };
  if (group !== 'search' && rest.some((a) => /:\/\/|github\.com/i.test(a))) return { kind: 'refused', why: 'Name the issue or PR by number, not by URL.' };
  if (group === 'search' && rest.some((a) => SEARCH_SCOPE.test(a))) return { kind: 'refused', why: 'Search names repos with --repo, never a qualifier.' };
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
  private readonly servers = new Map<string, { server: net.Server; conns: Set<net.Socket> }>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: GatewayDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /** Never across requesters: the key is the requester and the exact repo set. */
  private key(requestedBy: string, repos: string[]): string {
    return `${requestedBy}\n${[...repos].sort((a, b) => a.localeCompare(b)).join(',')}`;
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
    const raw: unknown = request.args;
    const args: string[] = Array.isArray(raw) && raw.every((a): a is string => typeof a === 'string') ? raw : [];
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
    const conns = new Set<net.Socket>();
    const server = net.createServer((conn) => {
      conns.add(conn);
      conn.on('close', () => conns.delete(conn));
      let buffered = '';
      let answered = false;
      conn.setEncoding('utf8');
      conn.on('error', () => conn.destroy());
      conn.on('data', (chunk: string) => {
        if (answered) return;
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
        answered = true;
        conn.pause();
        void this.handle(run, request).then((r) => conn.end(`${JSON.stringify(r)}\n`));
      });
    });
    this.servers.set(run.jobId, { server, conns });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        server.on('error', (err) => log.warn('[Crew] the GitHub gateway socket failed', err));
        fs.chmodSync(socketPath, 0o600);
        resolve();
      });
    });
  }

  close(jobId: string): void {
    const entry = this.servers.get(jobId);
    this.servers.delete(jobId);
    if (!entry) return;
    entry.server.close();
    for (const conn of entry.conns) conn.destroy();
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
