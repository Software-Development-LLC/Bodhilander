/**
 * The owner's end of "Fit to my screen".
 *
 * The rule these hold: a guest's request reaches a prompt and never the PTY,
 * accepting resizes once, and declining is indistinguishable from silence —
 * nothing is sent, and the guest's view is left exactly as it was.
 *
 * xterm and its addons are mocked for the same reason Terminal.restart.test.tsx
 * mocks them: a real xterm wants a canvas and a laid-out container, neither of
 * which happy-dom provides, and none of it is what is under test here.
 *
 * Run with: bun test src/renderer/components/__tests__/Terminal.resizeRequest.test.tsx
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import { RelayResizeRequest } from '../../../shared/types';

class FakeBuffer {
  active = { baseY: 0, viewportY: 0 };
}

const noop = () => {};

/** Resizes xterm was asked to make locally, so a stale render can be spotted. */
let termResizes: string[] = [];

class FakeTerm {
  cols = 164;
  rows = 48;
  buffer = new FakeBuffer();
  loadAddon = noop;
  open = noop;
  write = noop;
  clear = noop;
  focus = noop;
  selectAll = noop;
  scrollToBottom = noop;
  resize = (cols: number, rows: number) => { termResizes.push(`${cols}x${rows}`); };
  getSelection = () => '';
  attachCustomKeyEventHandler = noop;
  onData = noop;
  dispose = noop;
}

mock.module('xterm', () => ({ Terminal: FakeTerm }));
mock.module('xterm-addon-fit', () => ({ FitAddon: class { fit = noop; } }));
mock.module('xterm-addon-webgl', () => ({
  WebglAddon: class { onContextLoss = noop; dispose = noop; },
}));

const Terminal = (await import('../Terminal')).default;

let ptyResizes: string[] = [];
let deliverRequest: ((request: RelayResizeRequest) => void) | null = null;

const request = (over: Partial<RelayResizeRequest> = {}): RelayResizeRequest => ({
  sessionId: 's1',
  cols: 80,
  rows: 24,
  login: 'dana-k',
  displayName: 'Dana K',
  ...over,
});

beforeEach(() => {
  termResizes = [];
  ptyResizes = [];
  deliverRequest = null;

  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe = noop;
    disconnect = noop;
  };

  const noopSub = () => () => {};
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    createSession: async () => {},
    writeToSession: () => {},
    resizeSession: (_id: string, cols: number, rows: number) => { ptyResizes.push(`${cols}x${rows}`); },
    primePty: () => {},
    killSession: async () => {},
    onPtyData: noopSub,
    onPtyResize: noopSub,
    onRelayResizeRequest: (cb: (r: RelayResizeRequest) => void) => {
      deliverRequest = cb;
      return () => { deliverRequest = null; };
    },
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

/**
 * Mount, then let the startup path settle: creating the pty sends one resize
 * of its own, and that is not what any of these tests are about.
 */
async function renderTerminal() {
  const rendered = render(<Terminal sessionId="s1" cwd="/tmp" launchClaude provider="claude" isActive />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
  ptyResizes = [];
  termResizes = [];
  return rendered;
}

async function ask(over: Partial<RelayResizeRequest> = {}) {
  await act(async () => { deliverRequest!(request(over)); });
}

describe('a guest asking to be fitted to their screen', () => {
  test('nothing happens until the owner answers', async () => {
    await renderTerminal();
    await ask();

    // The prompt names the size being asked for; the PTY has not moved.
    expect(screen.getByText(/asked to fit this session to their screen/)).toBeTruthy();
    expect(screen.getByText(/80×24/)).toBeTruthy();
    expect(ptyResizes).toEqual([]);
  });

  test('accepting resizes once, and says so by its own name', async () => {
    await renderTerminal();
    await ask();

    await act(async () => { screen.getByText('Resize once').click(); });

    expect(ptyResizes).toEqual(['80x24']);
    // Rendered locally too, so the owner's window is not showing a grid the
    // PTY has stopped using.
    expect(termResizes).toContain('80x24');
    expect(screen.queryByText('Resize once')).toBeNull();
  });

  test('declining sends nothing at all — the guest is told by silence', async () => {
    await renderTerminal();
    await ask();

    await act(async () => { screen.getByText('Keep my size').click(); });

    expect(ptyResizes).toEqual([]);
    expect(termResizes).toEqual([]);
    expect(screen.queryByText(/asked to fit this session/)).toBeNull();
  });

  test('a request for another session is not this terminal\'s to answer', async () => {
    await renderTerminal();
    await ask({ sessionId: 's2' });

    expect(screen.queryByText(/asked to fit this session/)).toBeNull();
  });

  test('the person is named by the handle they cannot change', async () => {
    await renderTerminal();
    await ask();

    expect(screen.getByText(/@dana-k/)).toBeTruthy();
  });

  test('a second ask replaces the first rather than stacking prompts', async () => {
    await renderTerminal();
    await ask();
    await ask({ cols: 100, rows: 30 });

    expect(screen.getAllByText('Resize once')).toHaveLength(1);
    await act(async () => { screen.getByText('Resize once').click(); });
    expect(ptyResizes).toEqual(['100x30']);
  });
});
