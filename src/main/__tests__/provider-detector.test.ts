/**
 * Provider CLI detection tests (#97).
 *
 * - Contract test: one fully-populated status per registered provider
 *   (machine-independent; whether a CLI is installed depends on the machine).
 * - buildProbe unit tests: the three platform branches (POSIX login shell,
 *   native Windows, WSL) can't all execute on one machine, so their argv
 *   construction is asserted directly with process.platform / detectShell
 *   stubbed.
 *
 * Run with: bun test src/main/__tests__
 */
import { describe, expect, test, mock, afterEach } from 'bun:test';
// Type-only import — erased at runtime, so it doesn't load the mocked module.
import type { ShellInfo } from '../shell-detector';

mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
}));
// preferences pulls in better-sqlite3 via the database module — stub it.
mock.module('../repositories/preferences', () => ({
  getPreference: () => '',
}));

// Stub the shell detector: importing the real module AND mock.module-ing the
// same specifier deadlocks bun's loader, so tests use a platform-plausible
// default (matching what detectShell would return) plus per-test overrides.
const defaultShellInfo: ShellInfo = process.platform === 'win32'
  ? { shell: process.env.ComSpec ?? 'cmd.exe', args: [], isWSL: false }
  : { shell: process.env.SHELL ?? '/bin/zsh', args: ['-l', '-i'], isWSL: false };
let shellInfoOverride: ShellInfo | null = null;
mock.module('../shell-detector', () => ({
  detectShell: () => shellInfoOverride ?? defaultShellInfo,
}));

const { detectProviders, buildProbe, extractVersion } = await import('../provider-detector');
const { listProviders } = await import('../providers');

const realPlatform = process.platform;
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

afterEach(() => {
  setPlatform(realPlatform);
  shellInfoOverride = null;
});

describe('detectProviders', () => {
  test('returns a fully-populated status for every registered provider', async () => {
    const statuses = await detectProviders();
    const registry = listProviders();

    expect(statuses.map((s) => s.id).sort()).toEqual(registry.map((p) => p.id).sort());

    for (const s of statuses) {
      expect(typeof s.installed).toBe('boolean');
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.command.length).toBeGreaterThan(0);
      expect(s.installHint.length).toBeGreaterThan(0);
      expect(s.docsUrl.startsWith('https://')).toBe(true);
      expect(s.loginHint.length).toBeGreaterThan(0);
      if (!s.installed) {
        expect(s.version).toBeNull();
      }
    }
  }, 30_000);
});

describe('buildProbe platform branches', () => {
  test('POSIX: probes through the interactive login shell (-l -i -c), matching session launches', () => {
    setPlatform('darwin');
    shellInfoOverride = { shell: '/bin/zsh', args: ['-l', '-i'], isWSL: false };

    const probe = buildProbe('claude');
    expect(probe.lookup).toEqual(['/bin/zsh', ['-l', '-i', '-c', 'command -v claude']]);
    expect(probe.version).toEqual(['/bin/zsh', ['-l', '-i', '-c', 'claude --version']]);
  });

  test('native Windows: where.exe lookup, cmd.exe version', () => {
    setPlatform('win32');
    shellInfoOverride = {
      shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: [],
      isWSL: false,
    };

    const probe = buildProbe('codex');
    expect(probe.lookup).toEqual(['where.exe', ['codex']]);
    expect(probe.version).toEqual(['cmd.exe', ['/c', 'codex --version']]);
  });

  test('WSL: wraps through wsl.exe bash -lc with the configured distro args', () => {
    setPlatform('win32');
    shellInfoOverride = { shell: 'wsl.exe', args: ['-d', 'Ubuntu'], isWSL: true };

    const probe = buildProbe('grok');
    expect(probe.lookup).toEqual(['wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', 'command -v grok']]);
    expect(probe.version).toEqual(['wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', 'grok --version']]);
  });
});

describe('extractVersion', () => {
  test('picks the first line with a semver-looking token', () => {
    expect(extractVersion('2.1.207 (Claude Code)\n')).toBe('2.1.207 (Claude Code)');
    expect(extractVersion('codex-cli 0.48.2')).toBe('codex-cli 0.48.2');
  });

  test('skips plain-text banner lines without version tokens', () => {
    expect(extractVersion('Welcome to the CLI!\n\nv1.2.3')).toBe('v1.2.3');
  });

  test('returns null when nothing version-like appears', () => {
    expect(extractVersion('command not found')).toBeNull();
    expect(extractVersion('')).toBeNull();
  });
});
