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
  loadAddon = noop;
  open = noop;
  write = noop;
  onData = () => ({ dispose: noop });
  focus = noop;
  dispose = () => { this.disposed = true; };
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
