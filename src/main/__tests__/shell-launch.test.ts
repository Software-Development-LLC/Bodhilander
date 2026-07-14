/**
 * Shell-launch tests (#106): argv construction per platform branch, and the
 * env-ref safety invariant — no branch may reference an env var with
 * cmd.exe-style `%VAR%` textual expansion, which cannot be quoted safely.
 *
 * Run with: bun test src/main/__tests__
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { getShellLaunch } from '../shell-launch';
import type { ShellInfo } from '../shell-detector';

const realPlatform = process.platform;
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform });
}
afterEach(() => setPlatform(realPlatform));

const shell = (overrides: Partial<ShellInfo>): ShellInfo => ({
  shell: '/bin/zsh',
  args: [],
  isWSL: false,
  ...overrides,
});

describe('getShellLaunch branches', () => {
  test('POSIX: login shell, quoted-$ env refs', () => {
    setPlatform('darwin');
    const launch = getShellLaunch(shell({ shell: '/bin/zsh', args: ['-l', '-i'] }));
    expect(launch.shell).toBe('/bin/zsh');
    expect(launch.wrap('claude')).toEqual(['-l', '-i', '-c', 'claude']);
    expect(launch.envRef('ARENA_PROMPT')).toBe('"$ARENA_PROMPT"');
  });

  test('WSL: wraps through wsl.exe bash with distro args', () => {
    setPlatform('win32');
    const launch = getShellLaunch(shell({ shell: 'wsl.exe', args: ['-d', 'Ubuntu'], isWSL: true }));
    expect(launch.wrap('claude')).toEqual(['-d', 'Ubuntu', '--', 'bash', '-c', 'claude']);
    expect(launch.envRef('X')).toBe('"$X"');
  });

  test('Windows PowerShell: -Command wrap, $env: refs', () => {
    setPlatform('win32');
    const launch = getShellLaunch(
      shell({ shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' })
    );
    expect(launch.wrap('claude')).toEqual(['-NoLogo', '-Command', 'claude']);
    expect(launch.envRef('ARENA_PROMPT')).toBe('$env:ARENA_PROMPT');
  });

  test('cmd.exe reroutes to PowerShell at an absolute path (#106)', () => {
    setPlatform('win32');
    const launch = getShellLaunch(shell({ shell: 'C:\\Windows\\System32\\cmd.exe' }));
    // Never /c through cmd — %VAR% expansion is textual and injectable.
    expect(launch.shell.toLowerCase()).toContain('powershell.exe');
    expect(path_isAbsoluteWin(launch.shell)).toBe(true);
    expect(launch.wrap('claude')).toEqual(['-NoLogo', '-Command', 'claude']);
    expect(launch.envRef('ARENA_PROMPT')).toBe('$env:ARENA_PROMPT');
  });

  test('Git Bash on Windows: bash -c wrap', () => {
    setPlatform('win32');
    const launch = getShellLaunch(shell({ shell: 'C:\\Program Files\\Git\\bin\\bash.exe' }));
    expect(launch.wrap('claude')).toEqual(['-c', 'claude']);
    expect(launch.envRef('X')).toBe('"$X"');
  });

  test('invariant: no branch produces cmd-style %VAR% env refs', () => {
    const cases: Array<[string, ShellInfo]> = [
      ['darwin', shell({})],
      ['win32', shell({ shell: 'wsl.exe', args: ['-d', 'Ubuntu'], isWSL: true })],
      ['win32', shell({ shell: 'powershell.exe' })],
      ['win32', shell({ shell: 'cmd.exe' })],
      ['win32', shell({ shell: 'bash.exe' })],
    ];
    for (const [platform, info] of cases) {
      setPlatform(platform);
      expect(getShellLaunch(info).envRef('VAR').includes('%')).toBe(false);
    }
  });
});

/** Windows-style absolute path check that works when running tests on POSIX. */
function path_isAbsoluteWin(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}
