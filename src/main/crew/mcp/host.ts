/**
 * The main-process end of a run's two MCP servers. `claude` starts the relay
 * script from crew.json; the relay forwards each call here over a Unix socket
 * under userData, which no run can read, with the run's 32-byte token.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type Database from 'better-sqlite3';
import log from 'electron-log';
import { writeAudit } from '../audit';
import { newRunToken, SUN_PATH_MAX, tokenMatches } from '../run/sockets';

export const MCP_SERVERS = ['approve', 'tools'] as const;
export type McpServerName = (typeof MCP_SERVERS)[number];
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface McpServerHandler {
  tools(): McpTool[];
  call(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

export interface McpRun {
  jobId: string;
  hireId: string;
  servers: Record<McpServerName, McpServerHandler>;
}

interface Registered extends McpRun {
  token: string;
}

export type McpRequest = { token?: unknown; server?: unknown; op?: unknown; name?: unknown; arguments?: unknown };
export type McpAnswer = { ok: true; tools?: McpTool[]; result?: McpCallResult } | { ok: false; error: string };

export const textResult = (text: string, isError = false): McpCallResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

export function hostSocketPath(userData: string): string {
  const p = path.join(userData, 'crew', 'mcp.sock');
  if (Buffer.byteLength(p) >= SUN_PATH_MAX) throw new Error(`the Crew MCP socket path is over the sun_path limit: ${p}`);
  return p;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class McpHost {
  private readonly runs = new Map<string, Registered>();
  private server: net.Server | null = null;
  private listening: Promise<boolean> | null = null;

  constructor(private readonly db: Database.Database, readonly socketPath: string) {}

  /** The token the relay presents; one registration per job, replaced on a re-run. */
  register(run: McpRun): string {
    const token = newRunToken();
    this.runs.set(run.jobId, { ...run, token });
    return token;
  }

  unregister(jobId: string): void {
    this.runs.delete(jobId);
  }

  registered(jobId: string): boolean {
    return this.runs.has(jobId);
  }

  private find(token: unknown): Registered | null {
    if (typeof token !== 'string') return null;
    let found: Registered | null = null;
    for (const run of this.runs.values()) if (tokenMatches(token, run.token)) found = run;
    return found;
  }

  async answer(request: McpRequest): Promise<McpAnswer> {
    const run = this.find(request.token);
    if (!run) {
      writeAudit(this.db, null, 'mcp-refused', { reason: 'token' });
      return { ok: false, error: 'refused' };
    }
    const server = MCP_SERVERS.find((s) => s === request.server);
    if (!server) return { ok: false, error: 'unknown server' };
    const handler = run.servers[server];
    if (request.op === 'list') return { ok: true, tools: handler.tools() };
    if (request.op !== 'call' || typeof request.name !== 'string') return { ok: false, error: 'bad request' };
    if (!handler.tools().some((t) => t.name === request.name)) return { ok: true, result: textResult(`No tool named ${request.name}.`, true) };
    const args = isRecord(request.arguments) ? request.arguments : {};
    try {
      return { ok: true, result: await handler.call(request.name, args) };
    } catch (err) {
      log.warn(`[Crew] tool ${server}.${request.name} failed`, err);
      return { ok: true, result: textResult(`${request.name} failed.`, true) };
    }
  }

  /** Listens once; a failure is not kept, so the next run tries again. */
  ready(): Promise<boolean> {
    this.listening ??= Promise.resolve()
      .then(() => this.listen())
      .then(
        () => true,
        (err) => {
          log.error('[Crew] the MCP host could not listen', err);
          this.server?.close();
          this.server = null;
          this.listening = null;
          return false;
        },
      );
    return this.listening;
  }

  listen(): Promise<void> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    fs.rmSync(this.socketPath, { force: true });
    const server = net.createServer((conn) => this.serve(conn));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        fs.chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
  }

  private serve(conn: net.Socket): void {
    let buffered = '';
    conn.setEncoding('utf8');
    conn.on('error', () => conn.destroy());
    conn.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_REQUEST_BYTES) return conn.destroy();
      const cut = buffered.indexOf('\n');
      if (cut < 0) return;
      const line = buffered.slice(0, cut);
      buffered = '';
      conn.pause();
      let request: McpRequest;
      try {
        const parsed: unknown = JSON.parse(line);
        request = isRecord(parsed) ? parsed : {};
      } catch {
        request = {};
      }
      this.answer(request)
        .then((a) => conn.end(`${JSON.stringify(a)}\n`))
        .catch((err: unknown) => {
          log.warn('[Crew] an MCP request failed', err);
          conn.end(`${JSON.stringify({ ok: false, error: 'internal' })}\n`);
        });
    });
  }

  close(): void {
    this.server?.close();
    this.server = null;
    this.listening = null;
    this.runs.clear();
    fs.rmSync(this.socketPath, { force: true });
  }
}
