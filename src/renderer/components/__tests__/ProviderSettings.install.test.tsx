/**
 * Settings -> Providers "Install for me": main receives the command shown in
 * the confirm, and a refused start is reported rather than swallowed. The
 * install modal is mocked because it hosts an xterm Terminal.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { ProviderStatus } from '../../../shared/types';

const noop = () => {};

mock.module('../ProviderInstallModal', () => ({
  ProviderInstallModal: ({ command }: { command: string }) => <div>install modal: {command}</div>,
}));

const { ProviderSettings } = await import('../ProviderSettings');

const GROK: ProviderStatus = {
  id: 'grok',
  name: 'Grok',
  command: 'grok',
  installed: false,
  version: null,
  installHint: 'irm https://x.ai/cli/install.ps1 | iex',
  installCommand: 'irm https://x.ai/cli/install.ps1 | iex',
  docsUrl: 'https://docs.x.ai/build/overview',
  loginHint: 'grok login',
};

const MANUAL: ProviderStatus = { ...GROK, id: 'manual', name: 'Manual', installCommand: null };

let providers: ProviderStatus[] = [];
let installCalls: unknown[][] = [];
let installResult: () => Promise<{ ptyId: string; command: string }> = () => new Promise(noop);
let confirms: string[] = [];
let alerts: string[] = [];
const realConfirm = window.confirm;
const realAlert = window.alert;

beforeEach(() => {
  providers = [GROK];
  installCalls = [];
  confirms = [];
  alerts = [];
  installResult = () => new Promise(noop);
  window.confirm = (message?: string) => { confirms.push(String(message)); return true; };
  window.alert = (message?: unknown) => { alerts.push(String(message)); };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    detectProviders: async () => providers,
    vaultList: async () => [],
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

async function renderSettings() {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<ProviderSettings />); });
  return view;
}

async function clickInstall(view: ReturnType<typeof render>) {
  await act(async () => { fireEvent.click(view.getByText('Install for me')); });
}

describe('ProviderSettings install button', () => {
  test('sends main the command shown in the confirm', async () => {
    const view = await renderSettings();
    await clickInstall(view);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain(GROK.installCommand!);
    expect(installCalls).toEqual([['grok', GROK.installCommand]]);
  });

  test('a declined confirm starts nothing', async () => {
    window.confirm = () => false;
    const view = await renderSettings();
    await clickInstall(view);
    expect(installCalls).toEqual([]);
  });

  test('opens the install modal with the command main ran', async () => {
    installResult = async () => ({ ptyId: 'pty-1', command: 'ran: grok' });
    const view = await renderSettings();
    await clickInstall(view);
    expect(view.getByText('install modal: ran: grok')).toBeTruthy();
  });

  test('a refused start is reported to the user', async () => {
    installResult = () => Promise.reject(new Error('The install command changed since it was shown'));
    const view = await renderSettings();
    await clickInstall(view);
    expect(alerts).toEqual(['Install did not start: The install command changed since it was shown']);
    expect(view.queryByText(/install modal/)).toBeNull();
  });

  test('a provider with no install command offers no install', async () => {
    providers = [MANUAL];
    const view = await renderSettings();
    expect(view.getByText('Manual')).toBeTruthy();
    expect(view.queryByText('Install for me')).toBeNull();
    expect(installCalls).toEqual([]);
  });
});
