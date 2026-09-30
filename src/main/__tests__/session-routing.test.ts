/**
 * The one routing call every session-creation path shares. Run with: bun test <this file>
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

let route: (id: string) => unknown = () => null;
mock.module('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }));
mock.module('../account-failover', () => ({ routeNewSession: (id: string) => route(id) }));

const { routeNewSessionByUsage, setSessionRoutedListener } = await import('../session-routing');

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
