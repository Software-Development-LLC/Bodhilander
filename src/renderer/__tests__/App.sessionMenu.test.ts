import { describe, expect, test } from 'bun:test';
import { sessionMenuTail, stopSessionMenuItem } from '../App';
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

describe('sessionMenuTail', () => {
  const noop = () => {};
  const labels = (sessions: Session[], id = 's1') =>
    sessionMenuTail(sessions, id, noop, noop).map(item => item.label);

  test('a running session gets Stop directly above Close, after the separator', () => {
    expect(labels([session({ id: 's0' }), session()])).toEqual(['separator', 'Stop Session', 'Close Session']);
  });

  test('looks up the session it was asked about, not another one', () => {
    expect(labels([session({ id: 's0' }), session({ state: 'stopped' })])).toEqual(['separator', 'Close Session']);
  });

  test.each([
    ['stopped', { state: 'stopped' }],
    ['missing its working dir', { workingDirMissing: true }],
  ] as const)('a session %s gets no Stop, and Close stays last', (_, over) => {
    expect(labels([session(over)])).toEqual(['separator', 'Close Session']);
  });

  test('Close stays destructive and removes the session it was opened on', () => {
    const removed: string[] = [];
    const close = sessionMenuTail([session()], 's1', noop, id => { removed.push(id); }).at(-1)!;
    expect(close.danger).toBe(true);
    close.onClick();
    expect(removed).toEqual(['s1']);
  });
});
