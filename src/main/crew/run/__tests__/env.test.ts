import { describe, expect, test } from 'bun:test';
import { runArgs, runEnv } from '../env';

const parent = {
  PATH: '/usr/bin', HOME: '/Users/b', LANG: 'en_GB.UTF-8', LC_ALL: 'C', TMPDIR: '/var/t', TERM: 'xterm', USER: 'b', LOGNAME: 'b',
  GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_y', ANTHROPIC_API_KEY: 'sk-ant-api', ANTHROPIC_BASE_URL: 'http://x',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'r', CLAUDE_CONFIG_DIR: '/Users/b/.claude',
  SSH_AUTH_SOCK: '/tmp/ssh', AWS_SECRET_ACCESS_KEY: 'a', NODE_OPTIONS: '--require x', UNDEFINED: undefined,
};
const base = { configDir: '/acct/a1', ghConfigDir: '/hire/gh-config', shellDir: '/hire/empty-shell' };

describe('runEnv', () => {
  test('keeps only the allowlist and sets what Crew owns', () => {
    const env = runEnv(parent, { ...base, tokenOnFd: false });
    expect(env).toEqual({
      PATH: '/usr/bin', HOME: '/Users/b', LANG: 'en_GB.UTF-8', LC_ALL: 'C', TMPDIR: '/var/t', TERM: 'xterm', USER: 'b', LOGNAME: 'b',
      CLAUDE_CONFIG_DIR: '/acct/a1', GH_CONFIG_DIR: '/hire/gh-config', CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
      SHELL: '/bin/zsh', ZDOTDIR: '/hire/empty-shell', BASH_ENV: '', ENV: '',
    });
  });

  test('on a Crew token the descriptor is announced, never the token', () => {
    const env = runEnv(parent, { ...base, tokenOnFd: true });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe('3');
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    expect(Object.values(env).join('\n')).not.toContain('sk-ant');
    expect(Object.keys(env).filter((k) => /^(ANTHROPIC_|GH_TOKEN|GITHUB_TOKEN|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_OAUTH_REFRESH)/.test(k))).toEqual([]);
  });
});

describe('runArgs', () => {
  test('carries the run flags, and resumes only with a session', () => {
    const args = runArgs({ sessionId: null, settingsPath: '/hire/run/settings-owner.json', mcpConfigPath: '/hire/run/crew.json' });
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2)).toEqual(['--settings', '/hire/run/settings-owner.json']);
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', 'project']);
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2)).toEqual(['--mcp-config', '/hire/run/crew.json']);
    expect(args[args.indexOf('--disallowedTools') + 1].split(',')).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2)).toEqual(['--output-format', 'stream-json']);
    expect(args).not.toContain('--resume');
    const resumed = runArgs({ sessionId: 's1', settingsPath: 'x', mcpConfigPath: 'y' });
    expect(resumed.slice(1, 3)).toEqual(['--resume', 's1']);
  });
});
