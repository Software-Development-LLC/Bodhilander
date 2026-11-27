import { Database as BunDatabase } from 'bun:sqlite';
import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'index-spec-'));
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));
const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
const calls: string[] = [];
const stub: unknown = new Proxy(function () {}, {
  get: (_t, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => 0 : key === Symbol.iterator ? [][Symbol.iterator] : stub),
  apply: () => stub,
  construct: () => stub as object,
});
let ready: (() => void) | null = null;
const app = new Proxy(
  {
    whenReady: () => ({ then: (fn: () => void) => ((ready = fn), { catch: () => {} }) }),
    on: (event: string, fn: (...args: unknown[]) => void) => (handlers[event] ??= []).push(fn),
    requestSingleInstanceLock: () => true,
    isPackaged: false,
    getPath: () => userData,
    getVersion: () => '0.0.0',
  } as Record<string | symbol, unknown>,
  { get: (t, key) => (key in t ? t[key] : stub) },
);
const ELECTRON = ['BrowserWindow', 'ipcMain', 'dialog', 'shell', 'crashReporter', 'Notification', 'screen', 'safeStorage', 'powerMonitor', 'nativeTheme', 'Menu', 'MenuItem', 'Tray', 'clipboard', 'nativeImage', 'net', 'session', 'webContents', 'protocol', 'globalShortcut', 'systemPreferences', 'autoUpdater', 'utilityProcess', 'MessageChannelMain', 'desktopCapturer', 'powerSaveBlocker', 'inAppPurchase', 'contentTracing', 'netLog', 'pushNotifications', 'TouchBar', 'ShareMenu', 'webFrameMain', 'contextBridge', 'ipcRenderer'];
const electron: Record<string, unknown> = { app, ...Object.fromEntries(ELECTRON.map((k) => [k, stub])) };
mock.module('electron', () => ({ ...electron, default: electron }));
mock.module('electron-log', () => ({ default: stub }));
mock.module('node-pty', () => ({ spawn: stub }));
class MemoryDb extends BunDatabase {
  constructor() {
    super(':memory:');
  }
  pragma(sql: string) {
    return this.query(`PRAGMA ${sql}`).all();
  }
}
mock.module('better-sqlite3', () => ({ default: MemoryDb }));
mock.module('sodium-native', () => ({ default: stub }));
mock.module('../crew/crew-main', () => ({
  startCrew: () => calls.push('start'),
  crewRecordSignIn: () => calls.push('signed-in'),
  stopCrew: () => calls.push('stop'),
  crewRuntime: () => null,
}));

describe('the main process', () => {
  test('loads with Crew started by its ready callback and stopped by its quit cleanup', async () => {
    await import('../index');
    expect(typeof ready).toBe('function');
    expect(String(ready)).toMatch(/startCrew\(\)/);
    const quit = handlers['before-quit'] ?? [];
    expect(quit.some((fn) => /stopCrew\(\)/.test(String(fn)))).toBe(true);
    expect(calls).toEqual([]);
  });
});
