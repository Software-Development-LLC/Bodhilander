/**
 * A Crew run's environment and argument list. The environment is an
 * allowlist: no GitHub token, no Claude token, no ANTHROPIC_* variable.
 */
import type { RunScope } from '../protocol';

/** The only parent names a run keeps. */
const KEPT_ENV = /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TMPDIR|TERM)$/;

export const TOKEN_FD = 3;

export interface RunEnvInput {
  configDir: string;
  ghConfigDir: string;
  shellDir: string;
  /** The Crew token goes on descriptor 3; on the login fallback neither variable is set. */
  tokenOnFd: boolean;
  /** Put first on PATH: the directory holding the run's `gh` shim. */
  pathFirst?: string;
  /** The run's gateway socket and token, for the shim. */
  extra?: Record<string, string>;
  /** With `home`, PATH keeps only entries outside it or under a re-opened path. */
  home?: string;
  reopened?: readonly string[];
  /** The hire's own git config, so the user's global one is never read. */
  gitConfig?: string;
}

const under = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

function trimPath(value: string, home: string, reopened: readonly string[]): string {
  return value
    .split(':')
    .filter((entry) => entry !== '' && (!under(entry, home) || reopened.some((r) => under(entry, r))))
    .join(':');
}

export function runEnv(parent: Record<string, string | undefined>, input: RunEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) if (v !== undefined && KEPT_ENV.test(k)) env[k] = v;
  env.CLAUDE_CONFIG_DIR = input.configDir;
  env.GH_CONFIG_DIR = input.ghConfigDir;
  env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = '1';
  Object.assign(env, { SHELL: '/bin/zsh', ZDOTDIR: input.shellDir, BASH_ENV: '', ENV: '' });
  if (env.PATH && input.home) env.PATH = trimPath(env.PATH, input.home, input.reopened ?? []);
  if (!env.PATH) delete env.PATH;
  if (input.gitConfig) env.GIT_CONFIG_GLOBAL = input.gitConfig;
  if (input.pathFirst) env.PATH = env.PATH ? `${input.pathFirst}:${env.PATH}` : input.pathFirst;
  Object.assign(env, input.extra ?? {});
  if (input.tokenOnFd) {
    env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = String(TOKEN_FD);
    env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  }
  return env;
}

export const PERMISSION_PROMPT_TOOL = 'mcp__crew_approve__approve';
export const DISALLOWED_TOOLS = 'WebFetch,WebSearch,AskUserQuestion,EnterPlanMode,ExitPlanMode';

export interface RunArgsInput {
  sessionId: string | null;
  settingsPath: string;
  mcpConfigPath: string;
  model?: string;
}

/** The prompt goes on stdin, so no input can be read as a flag. */
export function runArgs(input: RunArgsInput): string[] {
  return [
    '-p',
    ...(input.sessionId ? ['--resume', input.sessionId] : []),
    '--settings', input.settingsPath,
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--mcp-config', input.mcpConfigPath,
    '--permission-prompt-tool', PERMISSION_PROMPT_TOOL,
    '--disallowedTools', DISALLOWED_TOOLS,
    ...(input.model ? ['--model', input.model] : []),
    '--output-format', 'stream-json',
    '--verbose',
  ];
}

export type { RunScope };

const WSL_TOOL_DIRS = ['/home/crew/.bodhilander/crew/bin', '/home/crew/.bodhilander/crew/node/bin'];
export const WSL_PATH = [...WSL_TOOL_DIRS, '/usr/local/bin', '/usr/bin', '/bin'].join(':');
const WSL_DROPPED = ['WSL_INTEROP', 'WSLENV', 'WSL_DISTRO_NAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'PULSE_SERVER', 'XDG_RUNTIME_DIR'];

/** A run inside BodhiCrew: the same allowlist, a Linux PATH and shell, no interop variables, and its own private TMPDIR. */
export function wslRunEnv(input: RunEnvInput & { tmpDir: string; home: string; user: string }): Record<string, string> {
  const env = runEnv({ PATH: WSL_PATH, HOME: input.home, USER: input.user, LOGNAME: input.user, LANG: 'C.UTF-8' }, { ...input, reopened: [...WSL_TOOL_DIRS, ...(input.reopened ?? [])] });
  for (const k of WSL_DROPPED) delete env[k];
  env.SHELL = '/bin/bash';
  env.TMPDIR = input.tmpDir;
  env.CLAUDE_CODE_TMPDIR = input.tmpDir;
  return env;
}
