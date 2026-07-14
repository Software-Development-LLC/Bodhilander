/**
 * Shell-launch tests (#106): argv construction per platform branch, and the
 * env-ref safety invariant — no branch may reference an env var with
 * cmd.exe-style `%VAR%` textual expansion, which cannot be quoted safely.
 *
 * Run with: bun test src/main/__tests__
 */
import { describe, expect, test, afterEach, mock } from 'bun:test';
import type { ShellInfo } from '../shell-detector';

// The cmd→PowerShell reroute resolves an absolute powershell.exe on disk;
// stub fs.existsSync so that path is testable on a POSIX runner.
let powershellExists = true;
mock.module('fs', () => ({
  existsSync: () => powershellExists,
}));

const { getShellLaunch } = await import('../shell-launch');

const realPlatform = process.platform;
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform });
}
afterEach(() => {
  setPlatform(realPlatform);
  powershellExists = true;
});

const shell = (overrides: Partial<ShellInfo>): ShellInfo => ({
  shell: '/bin/zsh',
  args: [],
  isWSL: false,
  ...overrides,
});

const ENV_REF = { needsEnvRef: true };

describe('getShellLaunch branches', () => {
  test('POSIX: login shell, quoted-$ env refs', () => {
    setPlatform('darwin');
    const launch = getShellLaunch(shell({ shell: '/bin/zsh', args: ['-l', '-i'] }), ENV_REF);
    expect(launch.shell).toBe('/bin/zsh');
    expect(launch.wrap('claude')).toEqual(['-l', '-i', '-c', 'claude']);
    expect(launch.envRef('ARENA_PROMPT')).toBe('"$ARENA_PROMPT"');
  });

  test('WSL: wraps through wsl.exe bash with distro args', () => {
    setPlatform('win32');
    const launch = getShellLaunch(shell({ shell: 'wsl.exe', args: ['-d', 'Ubuntu'], isWSL: true }), ENV_REF);
    expect(launch.wrap('claude')).toEqual(['-d', 'Ubuntu', '--', 'bash', '-c', 'claude']);
    expect(launch.envRef('X')).toBe('"$X"');
  });

  test('Windows PowerShell: -Command wrap, $env: refs', () => {
    setPlatform('win32');
    const launch = getShellLaunch(
      shell({ shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }),
      ENV_REF
    );
    expect(launch.wrap('claude')).toEqual(['-NoLogo', '-Command', 'claude']);
    expect(launch.envRef('ARENA_PROMPT')).toBe('$env:ARENA_PROMPT');
  });

  test('Git Bash on Windows: bash -c wrap', () => {
    setPlatform('win32');
    const launch = getShellLaunch(shell({ shell: 'C:\\Program Files\\Git\\bin\\bash.exe' }), ENV_REF);
    expect(launch.wrap('claude')).toEqual(['-c', 'claude']);
    expect(launch.envRef('X')).toBe('"$X"');
  });

  test('cmd.exe WITHOUT env-ref keeps the user shell; envRef throws if misused (#106)', () => {
    setPlatform('win32');
    const launch = getShellLaunch(shell({ shell: 'C:\\Windows\\System32\\cmd.exe' }), { needsEnvRef: false });
    // Login-pty case: cmd.exe is preserved, no PowerShell reroute.
    expect(launch.shell).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(launch.wrap('claude')).toEqual(['/c', 'claude']);
    expect(() => launch.envRef('X')).toThrow(/needsEnvRef/);
  });

  test('cmd.exe WITH env-ref reroutes to PowerShell at an absolute path (#106)', () => {
    setPlatform('win32');
    const launch = getShellLaunch(shell({ shell: 'C:\\Windows\\System32\\cmd.exe' }), ENV_REF);
    // Never /c through cmd — %VAR% expansion is textual and injectable.
    expect(launch.shell.toLowerCase()).toContain('powershell.exe');
    expect(path_isAbsoluteWin(launch.shell)).toBe(true);
    expect(launch.wrap('claude')).toEqual(['-NoLogo', '-Command', 'claude']);
    expect(launch.envRef('ARENA_PROMPT')).toBe('$env:ARENA_PROMPT');
  });

  test('cmd.exe env-ref reroute throws a clear error when PowerShell is absent', () => {
    setPlatform('win32');
    powershellExists = false;
    expect(() => getShellLaunch(shell({ shell: 'C:\\Windows\\System32\\cmd.exe' }), ENV_REF))
      .toThrow(/PowerShell not found/);
  });

  test('env-ref invariant: no branch produces cmd-style %VAR% refs', () => {
    const cases: Array<[string, ShellInfo]> = [
      ['darwin', shell({})],
      ['win32', shell({ shell: 'wsl.exe', args: ['-d', 'Ubuntu'], isWSL: true })],
      ['win32', shell({ shell: 'powershell.exe' })],
      ['win32', shell({ shell: 'cmd.exe' })],
      ['win32', shell({ shell: 'bash.exe' })],
    ];
    for (const [platform, info] of cases) {
      setPlatform(platform);
      expect(getShellLaunch(info, ENV_REF).envRef('VAR').includes('%')).toBe(false);
    }
  });
});

/** Windows-style absolute path check that works when running tests on POSIX. */
function path_isAbsoluteWin(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}
