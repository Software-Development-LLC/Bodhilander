/**
 * Entry point of the Claude Desktop extension. Claude Desktop runs this under
 * its own Node runtime and speaks MCP to it over stdio.
 */
import * as fs from 'fs';
import { ApiClientDeps, createApiClient, defaultDeps } from './api-client';
import { handleMessage, lineReader, RpcDeps } from './rpc';
import { callTool, ToolContext } from './tools';

declare const __BODHILANDER_VERSION__: string;

export function createContext(apiDeps: ApiClientDeps = defaultDeps()): ToolContext {
  return {
    api: createApiClient(apiDeps),
    platform: process.platform,
    dirExists: (dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    readyTimeoutMs: 40_000,
    pollMs: 1_500,
    settleMs: 3_000,
  };
}

export interface Stdio {
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
  log: (line: string) => void;
  /** Called once input has ended and every request it carried has been answered. */
  done: () => void;
}

export function serve(io: Stdio, ctx: ToolContext = createContext()): void {
  const deps: RpcDeps = {
    version: typeof __BODHILANDER_VERSION__ === 'string' ? __BODHILANDER_VERSION__ : '0.0.0',
    callTool: (name, args) => callTool(ctx, name, args),
  };
  let pending = 0;
  let closed = false;
  const finishWhenIdle = () => {
    if (closed && pending === 0) io.done();
  };

  const read = lineReader((message) => {
    pending++;
    handleMessage(message, deps)
      .then((response) => {
        if (response) io.write(`${JSON.stringify(response)}\n`);
      })
      .catch((err) => io.log(`bodhilander-mcp: ${String(err)}\n`))
      .finally(() => {
        pending--;
        finishWhenIdle();
      });
  });

  io.input.setEncoding('utf8');
  io.input.on('data', (chunk: string) => read(chunk));
  io.input.on('end', () => {
    closed = true;
    finishWhenIdle();
  });
}

if (typeof module !== 'undefined' && require.main === module) {
  serve({
    input: process.stdin,
    write: (line) => process.stdout.write(line),
    log: (line) => process.stderr.write(line),
    done: () => process.exit(0),
  });
}
