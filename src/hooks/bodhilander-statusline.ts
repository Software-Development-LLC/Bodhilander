#!/usr/bin/env node
/**
 * Usage: bodhilander-statusline.js <config-dir>, under the app's binary in Node
 * mode. Records `rate_limits` for the meters, then prints any chained statusLine.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { STATUSLINE_CHAIN_FILE, STATUSLINE_SINK_FILE } from '../shared/usage';
import { findGitBash } from '../main/git-bash';

const CHAIN_TIMEOUT_MS = 5_000;

export interface StatuslineDeps {
  now: () => number;
  runChain: (command: string, input: string) => string;
}

/** Record the rate limits, if the payload carries any. Never throws. */
export function recordRateLimits(configDir: string, stdinText: string, now: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return false;
  }
  const limits = (payload as { rate_limits?: unknown } | null)?.rate_limits;
  if (typeof limits !== 'object' || limits === null) return false;

  const file = path.join(configDir, STATUSLINE_SINK_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ observedAt: now, rate_limits: limits }), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

/** The user's own statusLine command, or null when there was none. */
export function readChainedCommand(configDir: string): string | null {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(configDir, STATUSLINE_CHAIN_FILE), 'utf-8'));
    const command = saved?.chain?.command;
    return typeof command === 'string' && command.trim() !== '' ? command : null;
  } catch {
    return null;
  }
}

function chainShell(): string | boolean {
  if (process.platform !== 'win32') return true;
  return findGitBash(process.env) ?? true;
}

/** The sink runs as Electron in Node mode; the user's command must not inherit that. */
export function chainEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

function runChainedCommand(command: string, input: string): string {
  const result = spawnSync(command, {
    input,
    env: chainEnv(process.env),
    shell: chainShell(),
    encoding: 'utf-8',
    timeout: CHAIN_TIMEOUT_MS,
    windowsHide: true,
  });
  return typeof result.stdout === 'string' ? result.stdout : '';
}

/** What to print as the status line: the chained command's stdout, or nothing. */
export function runStatusline(
  configDir: string,
  stdinText: string,
  deps: StatuslineDeps = { now: Date.now, runChain: runChainedCommand },
): string {
  recordRateLimits(configDir, stdinText, deps.now());
  const command = readChainedCommand(configDir);
  if (!command) return '';
  try {
    return deps.runChain(command, stdinText);
  } catch {
    return '';
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

if (require.main === module) {
  const configDir = process.argv[2];
  readStdin().then((input) => {
    if (configDir) process.stdout.write(runStatusline(configDir, input));
  }).catch(() => undefined);
}
