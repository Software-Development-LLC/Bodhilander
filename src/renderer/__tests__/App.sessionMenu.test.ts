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

  test('stops the session and leaves it in the list', () => {
    let sessions = [session(), session({ id: 's2' })];
    const updateSession = (id: string, updates: Partial<Session>) => {
      sessions = sessions.map(s => (s.id === id ? { ...s, ...updates } : s));
    };

    stopSessionMenuItem(sessions[0], updateSession)!.onClick();

    expect(sessions.map(s => s.id)).toEqual(['s1', 's2']);
    expect(sessions[0].state).toBe('stopped');
    expect(sessions[1].state).toBe('working');
  });
});
