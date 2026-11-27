import { describe, expect, mock, test } from 'bun:test';
import { crewDb } from './crew-db';

const prefs = new Map<string, string>();
const powerHandlers: Record<string, (() => void)[]> = {};
const appHandlers: Record<string, (() => void)[]> = {};
const sockets: { url: string; closed: boolean }[] = [];
const { db } = crewDb();

mock.module('electron', () => ({
  app: { isPackaged: true, on: (e: string, cb: () => void) => (appHandlers[e] ??= []).push(cb) },
  powerMonitor: { on: (e: string, cb: () => void) => (powerHandlers[e] ??= []).push(cb) },
  shell: { openExternal: async () => {} },
}));
mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));
mock.module('ws', () => ({
  WebSocket: class {
    constructor(url: string) {
      sockets.push({ url, closed: false });
    }
    on() {}
    send() {}
    close() {
      sockets[sockets.length - 1].closed = true;
    }
  },
}));
mock.module('../../database', () => ({ getDatabase: () => db }));
mock.module('../../repositories/preferences', () => ({
  getPreference: (k: string) => prefs.get(k) ?? null,
  setPreference: (k: string, v: string) => prefs.set(k, v),
  deletePreference: (k: string) => prefs.delete(k),
}));
mock.module('../../api/relay/relay-identity', () => ({
  ensureIdentity: () => ({ ed25519Pub: 'ED', x25519Pub: 'X' }),
  signWithIdentity: () => Buffer.from('s'),
}));

const { crewHubUrl, newLinkFlow, startCrewHub, stopCrewHub } = await import('../hub-service');
import * as os from 'os';

describe('the app Crew connection', () => {
  test('a packaged build talks to production unless crew.hubUrl says otherwise', () => {
    expect(crewHubUrl()).toBe('https://crew.bodhi.software');
    prefs.set('crew.hubUrl', 'https://h.example');
    expect(crewHubUrl()).toBe('https://h.example');
    prefs.delete('crew.hubUrl');
  });

  test('an unlinked machine opens nothing; a linked one connects, wires resume and quit', () => {
    const hub = startCrewHub();
    expect(sockets).toEqual([]);
    prefs.set('crew.machineId', '44444444-4444-4444-8444-444444444444');
    expect(startCrewHub()).toBe(hub);
    expect(sockets.map((s) => s.url)).toEqual(['wss://crew.bodhi.software/ws']);
    let resumed = 0;
    const original = hub.onResume.bind(hub);
    hub.onResume = () => {
      resumed += 1;
      original();
    };
    for (const cb of powerHandlers.resume ?? []) cb();
    expect(resumed).toBe(1);
    stopCrewHub();
    expect(sockets[0].closed).toBe(true);
  });

  test('the link request names the machine as the relay does, else by host name', () => {
    const nameOf = () => (newLinkFlow() as unknown as { deps: { name: string } }).deps.name;
    expect(nameOf()).toBe(os.hostname());
    prefs.set('relay.machineName', '  Studio  ');
    expect(nameOf()).toBe('Studio');
    prefs.set('relay.machineName', '   ');
    expect(nameOf()).toBe(os.hostname());
  });

  test('the app starts it after ready', async () => {
    const src = await Bun.file(new URL('../../index.ts', import.meta.url)).text();
    expect(src).toMatch(/startCrewHub\(\);/);
    expect(src).toMatch(/stopCrewHub\(\);/);
  });
});
