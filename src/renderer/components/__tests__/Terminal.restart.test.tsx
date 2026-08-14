/**
 * Terminal's restart ordering (#164).
 *
 * The bug this pins: restarting used to drop the pty and spawn its replacement
 * 100ms later, whether or not the old process had died. Claude Code routinely
 * outlives that, so the dying pty's exit landed on the replacement already
 * registered under the same session id — orphaning it (every keystroke
 * silently dropped) or, through the BDHLNDR-9 resume-failure fallback,
 * destroying the stored conversation UUID. The fix is an ordering guarantee,
 * not a longer guess: main resolves 'pty:kill' on the process's real exit and
 * the respawn waits for it. These tests hold that ordering, plus the three ways
 * out of it that must never strand a session in the stopped state.
 *
 * xterm and its addons are mocked because this file is the only test that
 * touches them (the convention at the top of pty-manager.test.ts): a real xterm
 * wants a canvas and a laid-out container, neither of which happy-dom provides,
 * and none of it is what is under test here.
 *
 * Run with: bun test src/renderer/components/__tests__/Terminal.restart.test.tsx
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render } from '@testing-library/react';

class FakeBuffer {
  active = { baseY: 0, viewportY: 0 };
}

/**
 * The xterm surface Terminal.tsx calls but these tests never assert on. Shared
 * so the fakes below declare which calls they tolerate without each one being
 * an empty body.
 */
const noop = () => {};

class FakeTerm {
  cols = 120;
  rows = 40;
  buffer = new FakeBuffer();
  disposed = false;
  loadAddon = noop;
  open = noop;
  write = noop;
  clear = noop;
  focus = noop;
  selectAll = noop;
  scrollToBottom = noop;
  resize = noop;
  getSelection = () => '';
  attachCustomKeyEventHandler = noop;
  onData = noop;
  dispose = () => { this.disposed = true; };
}

mock.module('xterm', () => ({ Terminal: FakeTerm }));
mock.module('xterm-addon-fit', () => ({ FitAddon: class { fit = noop; } }));
mock.module('xterm-addon-webgl', () => ({
  // Terminal loads this one behind a try/catch inside a rAF; throwing here
  // would exercise the fallback path rather than the restart path.
  WebglAddon: class { onContextLoss = noop; dispose = noop; },
}));

const Terminal = (await import('../Terminal')).default;

/** A killSession call the test can settle by hand, so "still dying" is a state. */
interface PendingKill {
  resolve: () => void;
  reject: (err: Error) => void;
}

let createdSessions: string[] = [];
let killCalls: string[] = [];
let pendingKills: PendingKill[] = [];

/** Settle every kill handed out so far — one real process exit, as main sees it. */
async function settleKills() {
  const kills = pendingKills;
  pendingKills = [];
  await act(async () => {
    for (const k of kills) k.resolve();
  });
}

beforeEach(() => {
  createdSessions = [];
  killCalls = [];
  pendingKills = [];

  // happy-dom has no ResizeObserver; the terminal observes its container.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe = noop;
    disconnect = noop;
  };

  const noopSub = () => () => {};
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    createSession: async (id: string) => { createdSessions.push(id); },
    writeToSession: () => {},
    resizeSession: () => {},
    primePty: () => {},
    killSession: (id: string) => {
      killCalls.push(id);
      return new Promise<void>((resolve, reject) => {
        pendingKills.push({ resolve, reject });
      });
    },
    onPtyData: noopSub,
    onPtyResize: noopSub,
    onProviderInstallHint: noopSub,
    onMenuCopy: noopSub,
    onMenuPaste: noopSub,
    onMenuSelectAll: noopSub,
    onMenuClearTerminal: noopSub,
    openExternal: () => {},
    runProviderInstall: async () => ({ ptyId: 'x', command: 'x' }),
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

function renderTerminal(restartKey: number) {
  return render(
    <Terminal sessionId="s1" cwd="/tmp" launchClaude provider="claude" restartKey={restartKey} isActive />
  );
}

describe('Terminal restart ordering (#164)', () => {
  test('the replacement pty is not spawned until the old one has actually died', async () => {
    const { rerender } = renderTerminal(0);
    expect(createdSessions).toEqual(['s1']);

    await act(async () => {
      rerender(
        <Terminal sessionId="s1" cwd="/tmp" launchClaude provider="claude" restartKey={1} isActive />
      );
    });

    // The kill is in flight and unresolved — which is exactly the window the
    // old 100ms timer used to spawn into.
    expect(killCalls.length).toBeGreaterThan(0);
    expect(createdSessions).toEqual(['s1']);

    await settleKills();
    expect(createdSessions).toEqual(['s1', 's1']);
  });

  test('both kills for one restart are issued — main coalesces them, we must not', async () => {
    const { rerender } = renderTerminal(0);
    await act(async () => {
      rerender(
        <Terminal sessionId="s1" cwd="/tmp" launchClaude provider="claude" restartKey={1} isActive />
      );
    });

    // One from the restart effect, one from the xterm effect's cleanup as
    // isRunning flips false. PtyManager.kill coalesces by id, so the second
    // waits on the first teardown's promise rather than concluding the process
    // is already gone. Suppressing either one here would put the ordering back
    // on a guess.
    expect(killCalls).toEqual(['s1', 's1']);
  });

  test('the kill window shows a waiting state, not a Start button that re-arms the race', async () => {
    const { rerender, container } = renderTerminal(0);

    await act(async () => {
      rerender(
        <Terminal sessionId="s1" cwd="/tmp" launchClaude provider="claude" restartKey={1} isActive />
      );
    });

    // Waiting for a real process to exit takes seconds, not the 100ms this
    // replaced. Showing "Session stopped" for that long reads as a failed
    // restart, and its Start button spawns a pty with no kill and no ordering
    // — create-before-death, by hand, in the middle of the fix for it.
    expect(container.querySelector('.terminal-restarting')).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('Session stopped');

    await settleKills();
    expect(container.querySelector('.terminal-restarting')).toBeNull();
    expect(createdSessions).toEqual(['s1', 's1']);
  });

  test('Stop pressed while the old pty is still dying is not overridden by the restart', async () => {
    const { rerender, container } = renderTerminal(0);

    await act(async () => {
      rerender(
        <Terminal sessionId="s1" cwd="/tmp" launchClaude provider="claude" restartKey={1} isActive />
      );
    });

    // The user gave up on a restart that is visibly taking seconds and hit
    // Stop. App writes state:'stopped', which arrives here as isStopped.
    await act(async () => {
      rerender(
        <Terminal sessionId="s1" cwd="/tmp" launchClaude provider="claude" restartKey={1} isActive isStopped />
      );
    });

    await settleKills();

    // The pty must stay dead. The [isStopped] effect cannot enforce this on its
    // own — it sets isRunning to false, which it already is, so React renders
    // nothing and a second Stop click changes no prop at all.
    expect(createdSessions).toEqual(['s1']);
    expect(container.querySelector('.terminal-stopped')).not.toBeNull();
    expect(container.textContent).toContain('Session stopped');
  });

  test('a kill that rejects still restarts rather than stranding the session', async () => {
    const { rerender, container } = renderTerminal(0);

    await act(async () => {
      rerender(
        <Terminal sessionId="s1" cwd="/tmp" launchClaude provider="claude" restartKey={1} isActive />
      );
    });

    const kills = pendingKills;
    pendingKills = [];
    await act(async () => {
      for (const k of kills) k.reject(new Error('pty:kill blew up'));
    });

    expect(createdSessions).toEqual(['s1', 's1']);
    expect(container.querySelector('.terminal-stopped')).toBeNull();
  });

  test('unmounting mid-restart does not respawn the pty behind the closed session', async () => {
    const { rerender, unmount } = renderTerminal(0);

    await act(async () => {
      rerender(
        <Terminal sessionId="s1" cwd="/tmp" launchClaude provider="claude" restartKey={1} isActive />
      );
    });
    expect(createdSessions).toEqual(['s1']);

    unmount();
    await settleKills();

    expect(createdSessions).toEqual(['s1']);
  });

  test('selecting another session does not restart one that was restarted before', async () => {
    const { rerender } = renderTerminal(0);
    await act(async () => {
      rerender(
        <Terminal sessionId="s1" cwd="/tmp" launchClaude provider="claude" restartKey={1} isActive />
      );
    });
    await settleKills();
    // The restart must have RUN before this proves anything. Without it the
    // component is still parked at isRunning=false, re-running the effect is a
    // no-op, and the assertions below hold for the wrong reason — which is how
    // this test passed against the 100ms-timer implementation it exists to
    // rule out (that timer never fires inside act()).
    expect(createdSessions).toEqual(['s1', 's1']);
    const killsAfterRestart = killCalls.length;
    const createsAfterRestart = createdSessions.length;

    // isActive is what changes when the user clicks a different session in the
    // sidebar. While it was a dependency of the restart effect, every such
    // click killed and respawned the pty of every session that had ever been
    // restarted — invisibly, because the terminal is only display:none.
    await act(async () => {
      rerender(
        <Terminal sessionId="s1" cwd="/tmp" launchClaude provider="claude" restartKey={1} isActive={false} />
      );
    });

    expect(killCalls.length).toBe(killsAfterRestart);
    expect(createdSessions.length).toBe(createsAfterRestart);
  });
});
