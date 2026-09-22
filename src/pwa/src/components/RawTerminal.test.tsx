/**
 * xterm and wsClient are mocked, same convention as the desktop Terminal
 * tests: a real xterm wants a laid-out container happy-dom cannot give it.
 */
import React from 'react';
import { afterEach, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';

const noop = () => {};

class FakeTerm {
  disposed = false;
  rows = 24;
  scrollCalls: number[] = [];
  loadAddon = noop;
  open = noop;
  write = noop;
  onData = () => ({ dispose: noop });
  focus = noop;
  scrollLines = (n: number) => { this.scrollCalls.push(n); };
  dispose = () => { this.disposed = true; };
}

/** happy-dom has no TouchEvent constructor; a plain Event with `touches` set is all the handler reads. */
function touch(type: string, clientY: number): Event {
  const e = new Event(type, { cancelable: true });
  Object.defineProperty(e, 'touches', { value: [{ clientY }] });
  return e;
}

let liveTerm: FakeTerm | null = null;

mock.module('@xterm/xterm', () => ({
  Terminal: class extends FakeTerm { constructor() { super(); liveTerm = this; } },
}));
mock.module('@xterm/addon-fit', () => ({ FitAddon: class { fit = noop; } }));
mock.module('../lib/ws', () => ({
  wsClient: {
    on: () => noop,
    send: noop,
    subscribeSession: () => noop,
  },
}));

const { RawTerminal } = await import('./RawTerminal');

afterEach(() => {
  cleanup();
  liveTerm = null;
});

test('mounts and unmounts without throwing, and disposes its xterm instance', () => {
  const { unmount } = render(<RawTerminal sessionId="s1" />);
  expect(liveTerm).not.toBeNull();

  unmount();

  expect(liveTerm?.disposed).toBe(true);
});

test('a touchmove drag scrolls by lines, and the listener is gone after unmount', () => {
  const { container, unmount } = render(<RawTerminal sessionId="s1" />);
  const host = container.querySelector('.overflow-auto') as HTMLDivElement;

  // happy-dom reports clientHeight 0, so the handler's per-line cell size
  // floors to 1px — a 20px drag is exactly 20 lines.
  host.dispatchEvent(touch('touchstart', 100));
  host.dispatchEvent(touch('touchmove', 80));
  expect(liveTerm?.scrollCalls).toEqual([20]);

  unmount();
  host.dispatchEvent(touch('touchstart', 100));
  host.dispatchEvent(touch('touchmove', 50));
  expect(liveTerm?.scrollCalls).toEqual([20]);
});
