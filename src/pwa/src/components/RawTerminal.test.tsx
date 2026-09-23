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
function touch(type: string, clientY: number, clientX = 0): Event {
  const e = new Event(type, { cancelable: true });
  Object.defineProperty(e, 'touches', { value: [{ clientX, clientY }] });
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
  const move = touch('touchmove', 80);
  host.dispatchEvent(move);
  expect(liveTerm?.scrollCalls).toEqual([20]);
  // The browser only respects preventDefault on a move it still considers
  // cancelable, which is why the CSS touch-action below matters too — but
  // this pins the call site so the guard can't be deleted silently.
  expect(move.defaultPrevented).toBe(true);

  unmount();
  host.dispatchEvent(touch('touchstart', 100));
  host.dispatchEvent(touch('touchmove', 50));
  expect(liveTerm?.scrollCalls).toEqual([20]);
});

test('the host opts out of native vertical pan so the browser never claims the gesture', () => {
  const { container } = render(<RawTerminal sessionId="s1" />);
  const host = container.querySelector('.overflow-auto') as HTMLDivElement;

  expect(host.classList.contains('touch-pan-x')).toBe(true);
  expect(host.classList.contains('touch-pinch-zoom')).toBe(true);
});

/** happy-dom's DOM nodes own addEventListener on their own internal EventTarget
 * class, a different object identity from the global `EventTarget.prototype` —
 * find the one actually in a node's chain so the spy below is reached. */
function ownerOfAddEventListener(node: object): { addEventListener: typeof EventTarget.prototype.addEventListener } {
  let proto = Object.getPrototypeOf(node);
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'addEventListener')) {
    proto = Object.getPrototypeOf(proto);
  }
  return proto;
}

test('the touchmove listener is registered non-passive, so preventDefault can work', () => {
  const owner = ownerOfAddEventListener(document.createElement('div'));
  const original = owner.addEventListener;
  // React registers its own delegated touch listeners too (with a plain
  // boolean, not an options object) — record the target so only the host's
  // own registration is asserted on below.
  const calls: { target: EventTarget; type: string; options: unknown }[] = [];
  owner.addEventListener = function (
    this: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions,
  ) {
    calls.push({ target: this, type, options });
    return original.call(this, type, listener, options);
  };

  let host: HTMLDivElement;
  try {
    host = render(<RawTerminal sessionId="s1" />).container.querySelector('.overflow-auto') as HTMLDivElement;
  } finally {
    owner.addEventListener = original;
  }

  const onHost = (t: string) => calls.find((c) => c.target === host && c.type === t)?.options;
  expect(onHost('touchmove')).toEqual({ passive: false });
  expect(onHost('touchstart')).toEqual({ passive: true });
});

test('a horizontal drag is left to native pan for the whole gesture', () => {
  const { container } = render(<RawTerminal sessionId="s1" />);
  const host = container.querySelector('.overflow-auto') as HTMLDivElement;

  host.dispatchEvent(touch('touchstart', 100, 100));
  const move = touch('touchmove', 105, 130); // dx=30, dy=5 — locks horizontal
  host.dispatchEvent(move);

  expect(liveTerm?.scrollCalls).toEqual([]);
  expect(move.defaultPrevented).toBe(false);
});
