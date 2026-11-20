/**
 * The extension's only way into Bodhilander: its local API, over loopback,
 * authenticated as the "Claude Desktop" paired device.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import {
  NOT_ENABLED_MESSAGE,
  discoveryPath,
  parseDiscovery,
  userDataCandidates,
} from '../shared/claude-desktop';

/** Shown to the model as a tool error; the message is the whole explanation. */
export class ToolError extends Error {}

export interface Connection {
  port: number;
  token: string;
}

export interface HttpReply {
  status: number;
  body: string;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  port: number;
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/** Rejects with `timedOut` set when the deadline passes; any other rejection is a connection failure. */
export type HttpSend = (request: HttpRequest) => Promise<HttpReply>;

export interface ApiClientDeps {
  send: HttpSend;
  readFile: (file: string) => string | null;
  userDataDirs: string[];
  timeoutMs: number;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

const LOOPBACK = '127.0.0.1';

const REVOKED_MESSAGE =
  "Bodhilander rejected Claude Desktop's credential: access was disabled or the device was unpaired. " +
  'Turn access back on in Bodhilander → Settings → Claude Desktop.';

export function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export const httpSend: HttpSend = (request) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: LOOPBACK, port: request.port, path: request.path, method: request.method, headers: request.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
      },
    );
    req.setTimeout(request.timeoutMs, () => {
      req.destroy(Object.assign(new Error('timed out'), { timedOut: true }));
    });
    req.on('error', reject);
    req.end(request.body);
  });

export function defaultDeps(): ApiClientDeps {
  return {
    send: httpSend,
    readFile: readFileOrNull,
    userDataDirs: userDataCandidates(process.platform, process.env, os.homedir()),
    timeoutMs: 15_000,
  };
}

/** Read fresh on every call, so a port change or a revoked device applies at once. */
export function loadConnection(deps: Pick<ApiClientDeps, 'readFile' | 'userDataDirs'>): Connection {
  for (const dir of deps.userDataDirs) {
    const text = deps.readFile(discoveryPath(dir));
    if (text === null) continue;
    const discovery = parseDiscovery(text);
    if (!discovery) {
      throw new ToolError(`${NOT_ENABLED_MESSAGE} (the discovery file is unreadable; turn access off and on again)`);
    }
    const token = deps.readFile(discovery.credentialPath)?.trim();
    if (!token) throw new ToolError(NOT_ENABLED_MESSAGE);
    return { port: discovery.port, token };
  }
  throw new ToolError(NOT_ENABLED_MESSAGE);
}

function errorText(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const { error, message } = body as { error?: unknown; message?: unknown };
    const parts = [error, message].filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (parts.length > 0) return parts.join(': ');
  }
  return null;
}

function statusError(status: number, body: unknown): ToolError {
  const detail = errorText(body);
  if (status === 401) return new ToolError(REVOKED_MESSAGE);
  if (status === 403) {
    return new ToolError(
      `Bodhilander refused this action (${detail ?? 'permission denied'}). ` +
        'Check the Claude Desktop device under Settings → Mobile App → Paired Devices.',
    );
  }
  if (status === 429) return new ToolError('Bodhilander is rate-limiting requests; try again in a minute.');
  const reason = detail ? `: ${detail}` : '';
  return new ToolError(`Bodhilander answered ${status}${reason}`);
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  async function request<T>(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<T> {
    const { port, token } = loadConnection(deps);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let reply: HttpReply;
    try {
      reply = await deps.send({
        method,
        port,
        path: `/api/v1${apiPath}`,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }),
        },
        body: payload,
        timeoutMs: deps.timeoutMs,
      });
    } catch (err) {
      if ((err as { timedOut?: boolean }).timedOut) {
        throw new ToolError(`Bodhilander did not answer within ${Math.round(deps.timeoutMs / 1000)}s.`);
      }
      throw new ToolError(
        `Bodhilander isn't reachable at ${LOOPBACK}:${port}. Make sure Bodhilander is running and its ` +
          'local API server is on (Settings → Mobile App → API Server).',
      );
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(reply.body);
    } catch {
      // A non-JSON body still has a status worth reporting.
    }
    if (reply.status < 200 || reply.status >= 300) throw statusError(reply.status, parsed);
    return parsed as T;
  }

  return {
    get: (apiPath) => request('GET', apiPath),
    post: (apiPath, body) => request('POST', apiPath, body),
  };
}
