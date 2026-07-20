/**
 * Provider install-command orchestration tests.
 *
 * The IPC argument validation here is a trust boundary: the renderer only
 * supplies ids, commands come from the static registry, and the cancel
 * channel must not be able to kill non-install ptys.
 *
 * Run with: bun test src/main/__tests__
 */
import { describe, expect, mock, test } from 'bun:test';
import type { PtyManager } from '../pty-manager';

// The real provider registry pulls in electron (socket-path helpers) — stub
// it, then load the modules under test dynamically (static imports would be
// hoisted above the mock).
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
}));

const { startProviderInstall, cancelProviderInstall, INSTALL_PTY_PREFIX } =
  await import('../provider-install');
const { listProviders } = await import('../providers');

interface StubCalls {
  killed: string[];
  created: Array<{ id: string; command: string }>;
}

function stubPtyManager(): { manager: PtyManager; calls: StubCalls } {
  const calls: StubCalls = { killed: [], created: [] };
  const manager = {
    kill: async (id: string) => {
      calls.killed.push(id);
    },
    createInstallSession: (id: string, command: string) => {
      calls.created.push({ id, command });
    },
  } as unknown as PtyManager;
  return { manager, calls };
}

describe('startProviderInstall', () => {
  test('spawns the registry install command under the install namespace', async () => {
    const { manager, calls } = stubPtyManager();
    const result = await startProviderInstall(manager, 'codex');

    expect(result.ptyId).toBe(`${INSTALL_PTY_PREFIX}codex`);
    expect(result.command).toBe(
      listProviders().find((p) => p.id === 'codex')!.setup.installCommand!
    );
    // Stale pty from a previous run is killed before the new spawn.
    expect(calls.killed).toEqual([result.ptyId]);
    expect(calls.created).toEqual([{ id: result.ptyId, command: result.command }]);
  });

  test('rejects unknown providers', async () => {
    const { manager, calls } = stubPtyManager();
    await expect(startProviderInstall(manager, 'not-a-provider')).rejects.toThrow(
      /no runnable install command/
    );
    expect(calls.created).toEqual([]);
  });

  test('rejects providers without a runnable install command', async () => {
    const guiOnly = listProviders().filter((p) => !p.setup.installCommand);
    // The registry currently has at least one GUI-install provider (antigravity).
    expect(guiOnly.length).toBeGreaterThan(0);

    for (const provider of guiOnly) {
      const { manager, calls } = stubPtyManager();
      await expect(startProviderInstall(manager, provider.id)).rejects.toThrow(
        /no runnable install command/
      );
      expect(calls.created).toEqual([]);
    }
  });

  test('rejects non-string and empty provider ids', async () => {
    const { manager, calls } = stubPtyManager();
    for (const bad of [undefined, null, 42, {}, '']) {
      await expect(startProviderInstall(manager, bad)).rejects.toThrow('Invalid providerId');
    }
    expect(calls.created).toEqual([]);
  });
});

describe('cancelProviderInstall', () => {
  test('kills ptys inside the install namespace', async () => {
    const { manager, calls } = stubPtyManager();
    await cancelProviderInstall(manager, `${INSTALL_PTY_PREFIX}codex`);
    expect(calls.killed).toEqual([`${INSTALL_PTY_PREFIX}codex`]);
  });

  test('rejects ids outside the install namespace — cannot kill session ptys', async () => {
    const { manager, calls } = stubPtyManager();
    for (const bad of [
      'some-session-uuid',
      '__login-abc',            // account-login pty
      ` ${INSTALL_PTY_PREFIX}x`, // prefix not at position 0
      undefined,
      null,
      42,
    ]) {
      await expect(cancelProviderInstall(manager, bad)).rejects.toThrow('Not an install pty');
    }
    expect(calls.killed).toEqual([]);
  });
});
