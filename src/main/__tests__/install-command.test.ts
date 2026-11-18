/**
 * Which registry install variant a provider shows and runs per platform and
 * shell; process.platform is stubbed so every branch runs on any machine.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

// The provider registry pulls in electron (socket-path helpers).
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
}));

const { resolveInstall } = await import('../install-command');
const { getProvider } = await import('../providers');

const realPlatform = process.platform;
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform });
}
afterEach(() => setPlatform(realPlatform));

const NATIVE = { isWSL: false };
const WSL = { isWSL: true };

const POWERSHELL_INSTALLERS: Record<string, string> = {
  kimi: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
  cursor: "irm 'https://cursor.com/install?win32=true' | iex",
  grok: 'irm https://x.ai/cli/install.ps1 | iex',
};

describe('resolveInstall', () => {
  test('native Windows: vendor PowerShell installers run under PowerShell, hint matches command', () => {
    setPlatform('win32');
    for (const [id, command] of Object.entries(POWERSHELL_INSTALLERS)) {
      expect(resolveInstall(getProvider(id).setup, NATIVE)).toEqual({
        installHint: command,
        installCommand: command,
        powershell: true,
      });
    }
  });

  test('native Windows: opencode installs through npm in the user shell', () => {
    setPlatform('win32');
    expect(resolveInstall(getProvider('opencode').setup, NATIVE)).toEqual({
      installHint: 'npm install -g opencode-ai',
      installCommand: 'npm install -g opencode-ai',
      powershell: false,
    });
  });

  test('native Windows: providers without a variant keep their registry values', () => {
    setPlatform('win32');
    for (const id of ['claude', 'codex']) {
      const { setup } = getProvider(id);
      expect(resolveInstall(setup, NATIVE)).toEqual({
        installHint: setup.installHint,
        installCommand: setup.installCommand!,
        powershell: false,
      });
    }
  });

  test('WSL, macOS and Linux keep the POSIX installer', () => {
    const cases: Array<[string, { isWSL: boolean }]> = [['win32', WSL], ['darwin', NATIVE], ['linux', NATIVE]];
    for (const [platform, shellInfo] of cases) {
      setPlatform(platform);
      for (const id of [...Object.keys(POWERSHELL_INSTALLERS), 'opencode']) {
        const { setup } = getProvider(id);
        expect(resolveInstall(setup, shellInfo)).toEqual({
          installHint: setup.installHint,
          installCommand: setup.installCommand!,
          powershell: false,
        });
        expect(setup.installCommand).toContain('| bash');
      }
    }
  });

  test('a variant without a runnable command resolves to null', () => {
    setPlatform('win32');
    const setup = {
      installHint: 'curl x | bash',
      installCommand: 'curl x | bash',
      windows: { installHint: 'Download the zip from x' },
      docsUrl: 'https://x',
      loginHint: 'x',
    };
    expect(resolveInstall(setup, NATIVE)).toEqual({
      installHint: 'Download the zip from x',
      installCommand: null,
      powershell: false,
    });
  });
});
