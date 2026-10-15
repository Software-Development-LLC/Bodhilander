/**
 * Enabling and disabling Claude Desktop access against a real PairingManager
 * on in-memory SQLite, with the files read back by the extension's own reader.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let db: Database;
mock.module('../database', () => ({ getDatabase: () => db }));
mock.module('electron-log', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));

const { PairingManager } = await import('../api/pairing/pairing-manager');
const { createClaudeDesktopAccess } = await import('../claude-desktop-access');
const { loadConnection, readFileOrNull } = await import('../../mcp-shim/api-client');
const {
  CLAUDE_DESKTOP_DEVICE_NAME,
  CLAUDE_DESKTOP_PLATFORM,
  NOT_ENABLED_MESSAGE,
  credentialPath,
  discoveryPath,
  parseDiscovery,
} = await import('../../shared/claude-desktop');

let userData: string;
let pairing: InstanceType<typeof PairingManager>;
let api: { running: boolean; port: number | null; startPort: number; startError: Error | null; starts: number };

function access() {
  return createClaudeDesktopAccess({
    userData,
    pairing,
    api: {
      isRunning: () => api.running,
      port: () => api.port,
      start: async () => {
        api.starts++;
        if (api.startError) throw api.startError;
        api.running = true;
        api.port = api.startPort;
        return { port: api.startPort };
      },
    },
    extensionPath: () => null,
  });
}

const read = () => loadConnection({ readFile: readFileOrNull, userDataDirs: [userData] });
const ours = () => pairing.getAllDevices().filter((d) => d.platform === CLAUDE_DESKTOP_PLATFORM);

beforeEach(() => {
  db = new Database(':memory:');
  pairing = new PairingManager();
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-cd-'));
  api = { running: true, port: 8443, startPort: 8450, startError: null, starts: 0 };
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('enable', () => {
  test('pairs a distinct Claude Desktop device and writes what the extension reads', async () => {
    const status = await access().enable();
    expect(status).toMatchObject({ enabled: true, apiRunning: true, port: 8443 });

    const devices = ours();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ name: CLAUDE_DESKTOP_DEVICE_NAME, canControl: true, canModify: true });
    expect(status.deviceId).toBe(devices[0].id);

    const conn = read();
    expect(conn.port).toBe(8443);
    expect(pairing.validateToken(conn.token)?.id).toBe(devices[0].id);
  });

  test('the discovery file holds the port and credential path, not the token', async () => {
    await access().enable();
    const text = fs.readFileSync(discoveryPath(userData), 'utf8');
    expect(parseDiscovery(text)).toEqual({ version: 1, port: 8443, credentialPath: credentialPath(userData) });
    expect(text).not.toContain(read().token);
  });

  test.skipIf(process.platform === 'win32')('the credential is readable by the user only', async () => {
    await access().enable();
    expect(fs.statSync(credentialPath(userData)).mode & 0o777).toBe(0o600);
  });

  test('is idempotent: a second enable keeps the same device and token', async () => {
    await access().enable();
    const first = read().token;
    await access().enable();
    expect(ours()).toHaveLength(1);
    expect(read().token).toBe(first);
  });

  test('replaces a device whose credential file was lost', async () => {
    await access().enable();
    const oldId = ours()[0].id;
    fs.rmSync(credentialPath(userData));
    await access().enable();
    expect(ours().map((d) => d.id)).not.toContain(oldId);
    expect(ours()).toHaveLength(1);
  });

  test('starts the API server when it is stopped, and records the port it landed on', async () => {
    api.running = false;
    api.port = null;
    await access().enable();
    expect(api.starts).toBe(1);
    expect(read().port).toBe(8450);
  });

  test('says so when the API server cannot start, and writes nothing', async () => {
    api.running = false;
    api.port = null;
    api.startError = new Error('EACCES');
    await expect(access().enable()).rejects.toThrow('The local API server could not start: EACCES');
    expect(fs.existsSync(discoveryPath(userData))).toBe(false);
    expect(ours()).toHaveLength(0);
  });

  test('leaves other paired devices alone', async () => {
    pairing.createDevice('Phone', 'ios', { canControl: true, canModify: false });
    await access().enable();
    await access().disable();
    expect(pairing.getAllDevices().map((d) => d.name)).toEqual(['Phone']);
  });
});

describe('disable and unpair', () => {
  test('disable unpairs the device, revokes the token and removes both files', async () => {
    await access().enable();
    const { token } = read();
    const status = access().disable();
    expect(status.enabled).toBe(false);
    expect(ours()).toHaveLength(0);
    expect(pairing.validateToken(token)).toBeNull();
    expect(fs.existsSync(credentialPath(userData))).toBe(false);
    expect(() => read()).toThrow(NOT_ENABLED_MESSAGE);
  });

  test('unpairing from the device list revokes access and cleans up the files', async () => {
    const a = access();
    await a.enable();
    const { token } = read();
    pairing.unpairDevice(ours()[0].id);
    expect(pairing.validateToken(token)).toBeNull();
    expect(a.status().enabled).toBe(false);
    a.onDeviceUnpaired();
    expect(() => read()).toThrow(NOT_ENABLED_MESSAGE);
  });

  test('unpairing some other device keeps Claude Desktop enabled', async () => {
    const a = access();
    const phone = pairing.createDevice('Phone', 'ios', { canControl: true, canModify: false });
    await a.enable();
    pairing.unpairDevice(phone.device.id);
    a.onDeviceUnpaired();
    expect(read().port).toBe(8443);
  });
});

describe('the API moving', () => {
  test('a restart on a new port is followed while enabled', async () => {
    const a = access();
    await a.enable();
    a.onApiStarted(9001);
    expect(read().port).toBe(9001);
  });

  test('a restart while disabled writes nothing', () => {
    access().onApiStarted(9001);
    expect(fs.existsSync(discoveryPath(userData))).toBe(false);
  });
});
