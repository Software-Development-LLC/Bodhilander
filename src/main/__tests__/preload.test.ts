/**
 * The renderer bridge. Channel names live here and in index.ts's handlers with
 * nothing joining them, so a rename on one side fails silently at runtime —
 * these pin the channels the import/export surface actually invokes.
 */
import { describe, expect, mock, test } from 'bun:test';

const invocations: { channel: string; args: unknown[] }[] = [];
let exposed: Record<string, (...args: unknown[]) => unknown> = {};

mock.module('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: Record<string, (...args: unknown[]) => unknown>) => {
      exposed = api;
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      invocations.push({ channel, args });
      return Promise.resolve(undefined);
    },
    on: () => {},
    removeListener: () => {},
    send: () => {},
  },
}));

await import('../preload');

function lastChannel(): string {
  return invocations[invocations.length - 1].channel;
}

describe('the import/export bridge', () => {
  test('exposes an export, an import, and the ClaudeLander shortcut', () => {
    for (const name of ['exportGroups', 'importGroups', 'importFromClaudeLander']) {
      expect(typeof exposed[name]).toBe('function');
    }
  });

  test('each routes to the channel index.ts registers', () => {
    exposed.exportGroups();
    expect(lastChannel()).toBe('export:groups');

    exposed.importGroups();
    expect(lastChannel()).toBe('import:groups');

    exposed.importFromClaudeLander();
    expect(lastChannel()).toBe('import:fromClaudeLander');
  });

  test('the folder picker forwards the directory it should open at', () => {
    exposed.selectDirectory('/some/where');

    const call = invocations[invocations.length - 1];
    expect(call.channel).toBe('dialog:selectDirectory');
    expect(call.args).toEqual(['/some/where']);
  });

  test('updating a session carries its patch through unchanged', () => {
    exposed.updateDbSession('s1', { workingDir: '/moved/here', state: 'stopped' });

    const call = invocations[invocations.length - 1];
    expect(call.args).toEqual(['s1', { workingDir: '/moved/here', state: 'stopped' }]);
  });
});
