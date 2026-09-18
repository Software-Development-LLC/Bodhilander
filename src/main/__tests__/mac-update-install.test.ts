import { describe, expect, test } from 'bun:test';
import { createMacUpdateInstaller } from '../mac-update-install';

function make(overrides: Partial<Parameters<typeof createMacUpdateInstaller>[0]> = {}) {
  const calls = { quit: 0, arm: 0 };
  const installer = createMacUpdateInstaller({
    isMac: true,
    quitAndInstall: () => {
      calls.quit++;
    },
    onArm: () => {
      calls.arm++;
    },
    ...overrides,
  });
  return { installer, calls };
}

describe('createMacUpdateInstaller', () => {
  test('nothing pending: arm() is a no-op and never calls quitAndInstall', () => {
    const { installer, calls } = make();
    expect(installer.hasPending()).toBe(false);
    expect(installer.arm()).toBe(false);
    expect(calls.quit).toBe(0);
    expect(calls.arm).toBe(0);
  });

  test('markDownloaded then arm(): installs exactly once', () => {
    const { installer, calls } = make();
    installer.markDownloaded();
    expect(installer.hasPending()).toBe(true);
    expect(installer.arm()).toBe(true);
    expect(calls.quit).toBe(1);
    expect(calls.arm).toBe(1);
  });

  test('arm() is idempotent — a second call (re-entrant quit) does nothing', () => {
    const { installer, calls } = make();
    installer.markDownloaded();
    installer.arm();
    expect(installer.hasPending()).toBe(false); // consumed by the first arm
    expect(installer.arm()).toBe(false);
    expect(calls.quit).toBe(1); // still just once
  });

  test('consume() clears the flag WITHOUT installing (the Restart Now path)', () => {
    const { installer, calls } = make();
    installer.markDownloaded();
    installer.consume();
    expect(installer.hasPending()).toBe(false);
    expect(installer.arm()).toBe(false);
    expect(calls.quit).toBe(0); // Restart Now ran its own quitAndInstall; we must not double up
  });

  test('flag is cleared BEFORE quitAndInstall — a throw still leaves it consumed', () => {
    let quitCalls = 0;
    const installer = createMacUpdateInstaller({
      isMac: true,
      quitAndInstall: () => {
        quitCalls++;
        throw new Error('staged update file missing');
      },
    });
    installer.markDownloaded();
    expect(() => installer.arm()).toThrow('staged update file missing');
    // Already consumed despite the throw, so the caller's fallback can hard-exit
    // and a retry can't fire a second install.
    expect(installer.hasPending()).toBe(false);
    expect(installer.arm()).toBe(false);
    expect(quitCalls).toBe(1);
  });

  test('non-macOS: inert — markDownloaded/arm never install', () => {
    const { installer, calls } = make({ isMac: false });
    installer.markDownloaded();
    expect(installer.hasPending()).toBe(false);
    expect(installer.arm()).toBe(false);
    expect(calls.quit).toBe(0);
  });
});
