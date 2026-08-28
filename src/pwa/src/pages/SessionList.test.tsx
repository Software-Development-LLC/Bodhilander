/**
 * What the mobile list says about a session the desktop will refuse to start.
 * Its stored state is 'stopped' like any other, so without this the companion
 * shows a session as ordinary when it cannot run at all.
 */
import { describe, expect, test } from 'bun:test';
import type { Session } from '../lib/types';
import { sessionPill } from './SessionList';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    groupId: 'g1',
    name: 'login flow',
    workingDir: '/Users/will/Work/Repos/App',
    state: 'idle',
    shellType: 'claude',
    order: 0,
    createdAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z',
    claudeSessionId: null,
    endedAt: null,
    durationSeconds: 0,
    claudeAccountId: null,
    ...overrides,
  };
}

describe('sessionPill', () => {
  test('reports the missing folder ahead of the stored state', () => {
    const pill = sessionPill(session({ state: 'stopped', workingDirMissing: true }));
    expect(pill.label).toBe('Needs folder');
  });

  test('the missing folder wins even while the row still claims to be idle', () => {
    expect(sessionPill(session({ state: 'idle', workingDirMissing: true })).label).toBe('Needs folder');
  });

  test('an ordinary session keeps its state pill', () => {
    expect(sessionPill(session({ state: 'working' })).label).toBe('Working');
    expect(sessionPill(session({ state: 'stopped' })).label).toBe('Stopped');
  });

  test('a desktop too old to report the field is treated as ordinary', () => {
    expect(sessionPill(session({ state: 'idle' })).label).toBe('Idle');
  });

  test('an unknown state from a newer desktop falls back rather than blanking', () => {
    const pill = sessionPill(session({ state: 'something-new' as Session['state'] }));
    expect(pill.label).toBe('Idle');
  });
});
