#!/usr/bin/env node
/**
 * Usage: bodhilander-statusline.js <config-dir>, under the app's binary in Node
 * mode. Records `rate_limits` for the meters, then prints the user's statusLine:
 * the one chained to, or the ambient `~/.claude` one when the dir had none.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, execFileSync, spawn } from 'child_process';

import { parseJsonText, STATUSLINE_CHAIN_FILE, STATUSLINE_SCRIPT_NAME, STATUSLINE_SINK_FILE } from '../shared/usage';
import { findGitBash } from '../main/git-bash';

const CHAIN_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 2_000;

export interface StatuslineDeps {
  now: () => number;
  runChain: (command: string, input: string) => Promise<string>;
  /** The config dir whose statusLine stands in when this one chained to none. */
  ambientDir: string;
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
    const saved = parseJsonText(fs.readFileSync(path.join(configDir, STATUSLINE_CHAIN_FILE), 'utf-8'));
    const command = (saved as { chain?: { command?: unknown } } | null)?.chain?.command;
    return typeof command === 'string' && command.trim() !== '' ? command : null;
  } catch {
    return null;
  }
}

/**
 * The statusLine command in a config dir's own settings.json, or null. A managed
 * dir does not inherit `~/.claude/settings.json`, so the sink reads it instead.
 */
function readSettingsCommand(configDir: string): string | null {
  try {
    const settings = parseJsonText(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8'));
    const command = (settings as { statusLine?: { command?: unknown } } | null)?.statusLine?.command;
    if (typeof command !== 'string' || command.trim() === '') return null;
    return command.includes(STATUSLINE_SCRIPT_NAME) ? null : command;
  } catch {
    return null;
  }
}

/** A chain file, readable or not, is the last word; only its absence falls back. */
function userCommand(configDir: string, ambientDir: string): string | null {
  if (fs.existsSync(path.join(configDir, STATUSLINE_CHAIN_FILE))) return readChainedCommand(configDir);
  return readSettingsCommand(ambientDir);
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

const KILL_OPTIONS = { stdio: 'ignore', timeout: KILL_TIMEOUT_MS, windowsHide: true } as const;

/** Sweeps until the group is empty: a process still being spawned escapes one pass. */
const killGroup = (pid: string) => `for _ in 1 2 3 4 5; do kill -9 -- -${pid} 2>/dev/null || exit 0; sleep 0.1; done`;

/**
 * The shell and everything it started: a survivor holds the output pipe open.
 * Git Bash runs a command as a Windows process whose parent has already exited,
 * so `taskkill /T` misses it; the shell's MSYS process group does not.
 */
function killTree(child: ChildProcess, gitBash: string | null, shellPid: string | undefined): void {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGKILL');
    } else if (gitBash && shellPid) {
      execFileSync(gitBash, ['-c', killGroup(shellPid)], KILL_OPTIONS);
    } else {
      const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      execFileSync(taskkill, ['/F', '/T', '/PID', String(child.pid)], KILL_OPTIONS);
    }
  } catch { /* already gone */ }
}

/** The command's stdout, or nothing when it fails to start or outlives the timeout. */
export function runChainedCommand(command: string, input: string, timeoutMs = CHAIN_TIMEOUT_MS): Promise<string> {
  const shell = chainShell();
  const gitBash = typeof shell === 'string' ? shell : null;
  return new Promise((resolve) => {
    const child = spawn(gitBash ? `echo $$ >&2; ${command}` : command, {
      env: chainEnv(process.env),
      shell,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', gitBash ? 'pipe' : 'ignore'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const finish = (out: string) => { clearTimeout(timer); resolve(out); };
    const timer = setTimeout(() => {
      killTree(child, gitBash, /^\d+/.exec(stderr)?.[0]);
      for (const stream of child.stdio) stream?.destroy();
      child.unref();
      finish('');
    }, timeoutMs);
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < 32) stderr += chunk; });
    child.on('error', () => finish(''));
    child.on('close', () => finish(stdout));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

function thisProcess(): StatuslineDeps {
  return { now: Date.now, runChain: runChainedCommand, ambientDir: path.join(os.homedir(), '.claude') };
}

/** What to print as the status line: the user command's stdout, or nothing. */
export async function runStatusline(
  configDir: string,
  stdinText: string,
  deps: StatuslineDeps = thisProcess(),
): Promise<string> {
  recordRateLimits(configDir, stdinText, deps.now());
  const command = userCommand(configDir, deps.ambientDir);
  if (!command) return '';
  try {
    return await deps.runChain(command, stdinText);
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
  readStdin().then(async (input) => {
    if (configDir) process.stdout.write(await runStatusline(configDir, input));
  }).catch(() => undefined).finally(() => process.stdout.write('', () => process.exit(0)));
}
