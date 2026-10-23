import { describe, expect, test } from 'bun:test';
import { stopSessionMenuItem } from '../App';
import type { Session } from '../../shared/types';

const session = (over: Partial<Session> = {}) => ({
  id: 's1', groupId: 'g1', name: 'login flow', workingDir: '/repo',
  state: 'working', shellType: 'claude', provider: 'claude', claudeAccountId: null,
  ...over,
} as Session);

describe('stopSessionMenuItem', () => {
  test.each(['idle', 'working', 'waiting', 'error'] as const)('is offered for a %s session', state => {
    const item = stopSessionMenuItem(session({ state }), () => {});
    expect(item?.label).toBe('Stop Session');
    expect(item?.danger).toBeFalsy();
  });

  test('is not offered for a stopped session', () => {
    expect(stopSessionMenuItem(session({ state: 'stopped' }), () => {})).toBeNull();
  });

  test('is not offered when the working directory is missing', () => {
    expect(stopSessionMenuItem(session({ workingDirMissing: true }), () => {})).toBeNull();
  });

  test('is not offered for a session the renderer has no row for', () => {
    expect(stopSessionMenuItem(undefined, () => {})).toBeNull();
  });

  test('clicking it marks the session stopped rather than removing it', () => {
    const calls: Array<[string, Partial<Session>]> = [];
    stopSessionMenuItem(session(), (id, updates) => { calls.push([id, updates]); })!.onClick();
    expect(calls).toEqual([['s1', { state: 'stopped' }]]);
  });
});
