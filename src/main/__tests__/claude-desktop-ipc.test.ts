import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ClaudeDesktopStatus } from '../../shared/types';

mock.module('electron-log', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));

const { registerClaudeDesktopIpc } = await import('../claude-desktop-ipc');

const STATUS: ClaudeDesktopStatus = { enabled: true, deviceId: 'd', apiRunning: true, port: 1, extensionAvailable: true };

let handlers: Map<string, () => unknown>;
let extension: string | null;
let openFailure: string;
let saveTo: string | null;
let copies: [string, string][];
let opened: string[];
let enableError: Error | null;

beforeEach(() => {
  handlers = new Map();
  extension = '/res/bodhilander.mcpb';
  openFailure = '';
  saveTo = '/home/w/bodhilander.mcpb';
  copies = [];
  opened = [];
  enableError = null;
  const access = {
    status: () => STATUS,
    enable: async () => { if (enableError) throw enableError; return STATUS; },
    disable: () => ({ ...STATUS, enabled: false }),
    onApiStarted: () => {},
    onDeviceUnpaired: () => {},
    dir: '/u/claude-desktop',
  };
  registerClaudeDesktopIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
    access: () => access,
    extensionPath: () => extension,
    openPath: async (file) => { opened.push(file); return openFailure; },
    chooseSavePath: async () => saveTo,
    copyFile: (from, to) => copies.push([from, to]),
  });
});

const invoke = (channel: string) => Promise.resolve(handlers.get(channel)!());

describe('Claude Desktop IPC', () => {
  test('registers every channel the preload exposes', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'claudeDesktop:disable', 'claudeDesktop:enable', 'claudeDesktop:getStatus',
      'claudeDesktop:install', 'claudeDesktop:saveExtension',
    ]);
  });

  test('enable and disable answer with the new status', async () => {
    expect(await invoke('claudeDesktop:enable')).toEqual({ success: true, status: STATUS });
    expect(await invoke('claudeDesktop:disable')).toEqual({ success: true, status: { ...STATUS, enabled: false } });
  });

  test('a failed enable is a result, not a thrown error', async () => {
    enableError = new Error('The local API server could not start: EACCES');
    expect(await invoke('claudeDesktop:enable')).toEqual({ success: false, error: 'The local API server could not start: EACCES' });
  });

  test('install opens the bundled extension with the OS handler', async () => {
    expect(await invoke('claudeDesktop:install')).toEqual({ success: true, status: STATUS });
    expect(opened).toEqual(['/res/bodhilander.mcpb']);
  });

  test('install reports the OS refusing to open it', async () => {
    openFailure = 'No application is associated';
    expect(await invoke('claudeDesktop:install')).toEqual({
      success: false, error: 'Could not open the extension: No application is associated',
    });
  });

  test('save copies the extension where the user chose', async () => {
    expect(await invoke('claudeDesktop:saveExtension')).toEqual({
      success: true, status: STATUS, message: 'Saved to /home/w/bodhilander.mcpb',
    });
    expect(copies).toEqual([['/res/bodhilander.mcpb', '/home/w/bodhilander.mcpb']]);
  });

  test('a cancelled save copies nothing', async () => {
    saveTo = null;
    expect(await invoke('claudeDesktop:saveExtension')).toEqual({ success: true, status: STATUS });
    expect(copies).toEqual([]);
  });

  test('a build without the extension says so for both actions', async () => {
    extension = null;
    for (const channel of ['claudeDesktop:install', 'claudeDesktop:saveExtension']) {
      expect(await invoke(channel)).toEqual({ success: false, error: 'This build does not include the Claude Desktop extension.' });
    }
    expect(opened).toEqual([]);
  });
});
