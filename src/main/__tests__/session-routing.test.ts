/**
 * The one routing call every session-creation path shares. Run with: bun test <this file>
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

let route: (id: string) => unknown = () => null;
mock.module('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }));
mock.module('../account-failover', () => ({ routeNewSession: (id: string) => route(id) }));
let resolve: (id: string) => { configDir: string } | null = () => null;
mock.module('../account-resolver', () => ({ resolveAccountForSession: (id: string) => resolve(id) }));

const { routeNewSessionByUsage, sessionTokenRefreshSettled, setSessionRoutedListener } = await import('../session-routing');
const { trackTokenRefresh } = await import('../token-refresh');

afterEach(() => {
  setSessionRoutedListener(null);
  route = () => null;
});

describe('routeNewSessionByUsage', () => {
  test('tells the listener about a session it moved', () => {
    const told: string[] = [];
    setSessionRoutedListener(id => told.push(id));
    route = () => ({ from: { label: 'Home' }, to: { label: 'Spare' } });
    routeNewSessionByUsage('s1');
    expect(told).toEqual(['s1']);
  });

  test('a session left where it was is not reported', () => {
    const told: string[] = [];
    setSessionRoutedListener(id => told.push(id));
    routeNewSessionByUsage('s1');
    expect(told).toEqual([]);
  });

  test('a routing failure never reaches the creation path', () => {
    const told: string[] = [];
    setSessionRoutedListener(id => told.push(id));
    route = () => { throw new Error('database is locked'); };
    expect(() => routeNewSessionByUsage('s1')).not.toThrow();
    expect(told).toEqual([]);
  });
});

describe('sessionTokenRefreshSettled', () => {
  test('waits for a refresh running on the session’s account', async () => {
    resolve = () => ({ configDir: '/cfg/work' });
    let finish: () => void = () => undefined;
    trackTokenRefresh('/cfg/work', new Promise<void>(done => { finish = done; }));
    let settled = false;
    const waiting = sessionTokenRefreshSettled('s1').then(() => { settled = true; });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    finish();
    await waiting;
    expect(settled).toBe(true);
  });

  test('a refresh on another account, or a resolver failure, does not hold the launch', async () => {
    resolve = () => ({ configDir: '/cfg/home' });
    trackTokenRefresh('/cfg/work', new Promise<void>(() => undefined));
    await expect(sessionTokenRefreshSettled('s1')).resolves.toBeUndefined();
    resolve = () => { throw new Error('database is locked'); };
    await expect(sessionTokenRefreshSettled('s1')).resolves.toBeUndefined();
  });
});
