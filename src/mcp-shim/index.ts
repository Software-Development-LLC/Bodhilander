/**
 * Entry point of the Claude Desktop extension. Claude Desktop runs this under
 * its own Node runtime and speaks MCP to it over stdio.
 */
import * as fs from 'fs';
import { createApiClient, defaultDeps } from './api-client';
import { handleMessage, lineReader } from './rpc';
import { callTool, ToolContext } from './tools';

declare const __BODHILANDER_VERSION__: string;

const ctx: ToolContext = {
  api: createApiClient(defaultDeps()),
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
  readyTimeoutMs: 60_000,
  pollMs: 1_500,
  settleMs: 3_000,
};

const deps = {
  version: typeof __BODHILANDER_VERSION__ === 'string' ? __BODHILANDER_VERSION__ : '0.0.0',
  callTool: (name: string, args: unknown) => callTool(ctx, name, args),
};

let pending = 0;
let closed = false;
const exitWhenIdle = () => {
  if (closed && pending === 0) process.exit(0);
};

const read = lineReader((message) => {
  pending++;
  handleMessage(message, deps)
    .then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    })
    .catch((err) => process.stderr.write(`bodhilander-mcp: ${String(err)}\n`))
    .finally(() => {
      pending--;
      exitWhenIdle();
    });
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => read(chunk));
process.stdin.on('end', () => {
  closed = true;
  exitWhenIdle();
});
