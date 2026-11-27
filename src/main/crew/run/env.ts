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
}

export function runEnv(parent: Record<string, string | undefined>, input: RunEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) if (v !== undefined && KEPT_ENV.test(k)) env[k] = v;
  env.CLAUDE_CONFIG_DIR = input.configDir;
  env.GH_CONFIG_DIR = input.ghConfigDir;
  env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = '1';
  Object.assign(env, { SHELL: '/bin/zsh', ZDOTDIR: input.shellDir, BASH_ENV: '', ENV: '' });
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
