import { beforeEach, describe, expect, mock, test } from 'bun:test';

let listens = 0;
let releaseListen: () => void = () => {};
let failListen: (err: Error) => void = () => {};
const closedSockets: string[] = [];
let unpairHook: ((deviceId: string) => void) | undefined;

mock.module('electron-log', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));
mock.module('../pairing/pairing-manager', () => ({
  PairingManager: class {
    getDeviceCount() { return 0; }
    unpairDevice(id: string) { return id === 'device-9'; }
  },
}));
mock.module('../ws-server', () => ({
  createWsServer: () => ({
    close() {},
    getClientCount: () => 0,
    closeConnectionsForDevice(id: string) { closedSockets.push(id); },
  }),
}));
mock.module('../http-server', () => ({
  createHttpServer: async (config: { onDeviceUnpaired?: (id: string) => void }) => {
    listens++;
    unpairHook = config.onDeviceUnpaired;
    await new Promise<void>((resolve, reject) => { releaseListen = resolve; failListen = reject; });
    return { server: { close: (cb: () => void) => cb() }, port: 8443 };
  },
}));

const { createApiServer } = await import('../index');
const server = createApiServer();

beforeEach(async () => {
  await server.stop();
  listens = 0;
});

describe('ApiServer.start', () => {
  test('a start that overlaps one in flight shares it instead of failing', async () => {
    const first = server.start();
    const second = server.start();
    await Promise.resolve();
    releaseListen();
    const [a, b] = await Promise.all([first, second]);
    expect(listens).toBe(1);
    expect(a.port).toBe(8443);
    expect(b.port).toBe(8443);
    expect(server.isRunning).toBe(true);
  });

  test('starting a running server is still refused', async () => {
    const started = server.start();
    await Promise.resolve();
    releaseListen();
    await started;
    await expect(server.start()).rejects.toThrow('already running');
  });

  test('an unpair through the HTTP routes is announced', async () => {
    const started = server.start();
    await Promise.resolve();
    releaseListen();
    await started;
    const seen: string[] = [];
    server.on('deviceUnpaired', (id: string) => seen.push(id));
    unpairHook?.('device-9');
    expect(seen).toEqual(['device-9']);
  });

  test('a failed start can be retried', async () => {
    const failed = server.start();
    await Promise.resolve();
    failListen(new Error('EADDRINUSE'));
    await expect(failed).rejects.toThrow('EADDRINUSE');
    const retried = server.start();
    await Promise.resolve();
    releaseListen();
    expect((await retried).port).toBe(8443);
    expect(listens).toBe(2);
  });

  test('unpairDevice closes the device\'s WebSockets and announces it', async () => {
    const started = server.start();
    await Promise.resolve();
    releaseListen();
    await started;
    closedSockets.length = 0;
    const seen: string[] = [];
    server.on('deviceUnpaired', (id: string) => seen.push(id));
    expect(server.unpairDevice('device-9')).toBe(true);
    expect(closedSockets).toEqual(['device-9']);
    expect(seen).toEqual(['device-9']);
  });

  test('unpairing a device that does not exist closes nothing', async () => {
    closedSockets.length = 0;
    expect(server.unpairDevice('nobody')).toBe(false);
    expect(closedSockets).toEqual([]);
  });
});
