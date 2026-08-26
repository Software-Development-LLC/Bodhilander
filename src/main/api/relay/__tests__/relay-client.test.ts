/**
 * The relay client's handoff seam. It is the one place that decides a machine
 * is ready to reach its account's slot at all, and "not linked yet" has to be
 * an answer rather than a thrown error — it is asked on every launch.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';

let db: Database;

// Superset stub: this module's import graph reaches most of the Electron main
// surface, and none of it is exercised here.
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata', getVersion: () => '3.5.1', on: () => {} },
  powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => false },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: class {
    static getAllWindows() { return []; }
  },
  Notification: class {
    static isSupported() { return false; }
  },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  Tray: class {},
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  nativeImage: { createFromPath: () => ({}) },
  shell: { openExternal: async () => {} },
  clipboard: { writeText: () => {} },
  nativeTheme: { shouldUseDarkColors: false },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
}));
mock.module('../../../database', () => ({ getDatabase: () => db }));

// `relay-client` reaches `pty-manager`, which loads node-pty's native binding
// at import. There is no Linux prebuild in this checkout, so without this the
// import throws on CI — and bun reports that as an unhandled error between
// tests rather than a failure, which is to say the file silently runs nothing.
mock.module('node-pty', () => ({
  spawn: () => { throw new Error('no pty spawns in these tests'); },
}));

const { RelayClient } = await import('../relay-client');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT)');
});

afterEach(() => db.close());

function setPref(key: string, value: string) {
  db.query('INSERT INTO preferences (key, value) VALUES (?, ?)').run(key, value);
}

describe('reaching the handoff slot', () => {
  test('is null until this machine has been claimed by an account', () => {
    expect(new RelayClient().handoffTransport()).toBeNull();
  });

  test('is available once it has, and every call it makes is signed', () => {
    setPref('relay.machineId', 'machine-1');
    const transport = new RelayClient().handoffTransport();
    expect(transport).not.toBeNull();
    for (const verb of ['upload', 'peek', 'download', 'acknowledge'] as const) {
      expect(typeof transport![verb]).toBe('function');
    }
  });
});
