/**
 * The launch-failure banner's "Install for me": main receives the command the
 * user confirmed, and a refused start is reported rather than swallowed.
 * xterm is mocked as in Terminal.restart.test.tsx.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { ProviderInstallHint } from '../../../shared/types';

const noop = () => {};

class FakeTerm {
  cols = 120;
  rows = 40;
  buffer = { active: { baseY: 0, viewportY: 0 } };
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
  dispose = noop;
}

mock.module('@xterm/xterm', () => ({ Terminal: FakeTerm }));
mock.module('@xterm/addon-fit', () => ({ FitAddon: class { fit = noop; } }));
mock.module('@xterm/addon-webgl', () => ({
  WebglAddon: class { onContextLoss = noop; dispose = noop; },
}));

const Terminal = (await import('../Terminal')).default;

const HINT: ProviderInstallHint = {
  sessionId: 's1',
  providerId: 'grok',
  providerName: 'Grok',
  command: 'grok',
  kind: 'missing',
  installHint: 'irm https://x.ai/cli/install.ps1 | iex',
  installCommand: 'irm https://x.ai/cli/install.ps1 | iex',
  docsUrl: 'https://docs.x.ai/build/overview',
};

let emitHint: ((hint: ProviderInstallHint) => void) | null = null;
let installCalls: unknown[][] = [];
let installResult: () => Promise<{ ptyId: string; command: string }> = () => new Promise(noop);
let alerts: string[] = [];
const realConfirm = window.confirm;
const realAlert = window.alert;

beforeEach(() => {
  emitHint = null;
  installCalls = [];
  alerts = [];
  installResult = () => new Promise(noop);
  window.confirm = () => true;
  window.alert = (message?: unknown) => { alerts.push(String(message)); };
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe = noop;
    disconnect = noop;
  };
  const noopSub = () => () => {};
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    createSession: async () => {},
    writeToSession: noop,
    resizeSession: noop,
    primePty: noop,
    killSession: async () => {},
    onPtyData: noopSub,
    onPtyResize: noopSub,
    onRelayResizeRequest: noopSub,
    onProviderInstallHint: (cb: (hint: ProviderInstallHint) => void) => {
      emitHint = cb;
      return noop;
    },
    onMenuCopy: noopSub,
    onMenuPaste: noopSub,
    onMenuSelectAll: noopSub,
    onMenuClearTerminal: noopSub,
    openExternal: noop,
    runProviderInstall: (...args: unknown[]) => {
      installCalls.push(args);
      return installResult();
    },
  };
});

afterEach(() => {
  cleanup();
  window.confirm = realConfirm;
  window.alert = realAlert;
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function clickInstall() {
  const view = render(<Terminal sessionId="s1" cwd="/tmp" launchClaude provider="grok" restartKey={0} isActive />);
  await act(async () => { emitHint!(HINT); });
  await act(async () => { fireEvent.click(view.getByText('Install for me')); });
}

describe('Terminal install banner', () => {
  test('sends main the command the user confirmed', async () => {
    await clickInstall();
    expect(installCalls).toEqual([['grok', HINT.installCommand]]);
  });

  test('a refused start is reported to the user', async () => {
    installResult = () => Promise.reject(new Error('The install command changed since it was shown'));
    await clickInstall();
    expect(alerts).toEqual(['Install did not start: The install command changed since it was shown']);
  });
});
