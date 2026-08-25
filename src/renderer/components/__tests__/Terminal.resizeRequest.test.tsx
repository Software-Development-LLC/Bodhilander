/**
 * The owner's end of "Fit to my screen": a request reaches a prompt and never
 * the PTY, accepting resizes once, declining sends nothing. xterm is mocked as
 * in Terminal.restart.test.tsx — a real one wants a canvas we cannot give it.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import { RelayResizeRequest } from '../../../shared/types';

class FakeBuffer {
  active = { baseY: 0, viewportY: 0 };
}

const noop = () => {};

/** The grid this window's container measures to, unchanged all test long. */
const CONTAINER = { cols: 164, rows: 48 };

/** Resizes xterm was asked to make locally, so a stale render can be spotted. */
let termResizes: string[] = [];
let liveTerm: FakeTerm | null = null;

class FakeTerm {
  cols = CONTAINER.cols;
  rows = CONTAINER.rows;
  buffer = new FakeBuffer();
  loadAddon = noop;
  open = noop;
  write = noop;
  clear = noop;
  focus = noop;
  selectAll = noop;
  scrollToBottom = noop;
  // A real resize MOVES the grid. A double that only records it cannot show a
  // later fit putting the size back, which is the whole subject here.
  resize = (cols: number, rows: number) => {
    termResizes.push(`${cols}x${rows}`);
    this.cols = cols;
    this.rows = rows;
  };
  getSelection = () => '';
  attachCustomKeyEventHandler = noop;
  onData = noop;
  dispose = noop;
  constructor() { liveTerm = this; }
}

mock.module('xterm', () => ({ Terminal: FakeTerm }));
// fit() re-measures the container and reflows the terminal to it — the real
// behaviour, and the thing that used to undo an accepted fit on any focus.
mock.module('xterm-addon-fit', () => ({
  FitAddon: class {
    fit = () => {
      if (!liveTerm) return;
      liveTerm.cols = CONTAINER.cols;
      liveTerm.rows = CONTAINER.rows;
    };
  },
}));
mock.module('xterm-addon-webgl', () => ({
  WebglAddon: class { onContextLoss = noop; dispose = noop; },
}));

const Terminal = (await import('../Terminal')).default;

let ptyResizes: string[] = [];
let deliverRequest: ((request: RelayResizeRequest) => void) | null = null;
let deliverPtyResize: ((id: string, cols: number, rows: number) => void) | null = null;

const request = (over: Partial<RelayResizeRequest> = {}): RelayResizeRequest => ({
  sessionId: 's1',
  cols: 80,
  rows: 24,
  login: 'dana-k',
  displayName: 'Dana K',
  ...over,
});

/** handleResize measures the container; happy-dom reports every box as zero. */
let realRect: typeof HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  termResizes = [];
  ptyResizes = [];
  deliverRequest = null;
  deliverPtyResize = null;
  liveTerm = null;

  realRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 1200, height: 600, top: 0, left: 0, right: 1200, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

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
    onPtyResize: (cb: (id: string, cols: number, rows: number) => void) => {
      deliverPtyResize = cb;
      return () => { deliverPtyResize = null; };
    },
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
  HTMLElement.prototype.getBoundingClientRect = realRect;
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

  test('the prompt in front of the owner is the one they answer', async () => {
    // A second guest asking between the reading and the click must not swap
    // the number under the button: the owner would agree to a size they never
    // saw, and sanitizeSize's floor of 2×2 is the worst case of that.
    await renderTerminal();
    await ask();
    await ask({ cols: 100, rows: 30, login: 'someone-else' });

    expect(screen.getAllByText('Resize once')).toHaveLength(1);
    expect(screen.getByText(/80×24/)).toBeTruthy();
    await act(async () => { screen.getByText('Resize once').click(); });
    expect(ptyResizes).toEqual(['80x24']);
  });
});

describe('an accepted fit is held until the owner takes it back', () => {
  test('the owner alt-tabbing away and back does not quietly undo it', async () => {
    // The bug: focus → handleResize → fit() re-measures the unchanged
    // container → the desktop grid is pushed straight back, the guest is
    // panning 164 columns again, and nobody is told. One focus event was
    // enough, and the guest cannot ask again for ten seconds.
    await renderTerminal();
    await ask();
    await act(async () => { screen.getByText('Resize once').click(); });
    expect(ptyResizes).toEqual(['80x24']);

    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { window.dispatchEvent(new Event('resize')); });

    expect(ptyResizes).toEqual(['80x24']);
    // And the standing offer to take it back is still on screen.
    expect(screen.getByText('Resume desktop size')).toBeTruthy();
  });

  test('taking the size back is one deliberate click', async () => {
    await renderTerminal();
    await ask();
    await act(async () => { screen.getByText('Resize once').click(); });

    await act(async () => { screen.getByText('Resume desktop size').click(); });

    expect(ptyResizes).toEqual(['80x24', '164x48']);
    expect(screen.queryByText('Resume desktop size')).toBeNull();
  });

  test('a window that granted nothing still re-fits on focus as it always did', async () => {
    // The hold must be scoped to a granted fit. Breaking the ordinary path —
    // where focus and window resize keep the PTY matched to the container —
    // would be a far larger regression than the one being fixed.
    await renderTerminal();

    await act(async () => { window.dispatchEvent(new Event('focus')); });

    expect(ptyResizes).toEqual(['164x48']);
  });

  test('after the size comes back by another route, re-fitting is allowed again', async () => {
    // The desktop grid arriving on pty:resized means whatever was held for a
    // guest is over — otherwise this window would refuse to fit for good.
    await renderTerminal();
    await ask();
    await act(async () => { screen.getByText('Resize once').click(); });

    await act(async () => { deliverPtyResize!('s1', 164, 48); });
    await act(async () => { window.dispatchEvent(new Event('focus')); });

    expect(ptyResizes).toEqual(['80x24', '164x48']);
  });
});
