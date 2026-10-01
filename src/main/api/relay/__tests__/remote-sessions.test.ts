/**
 * A session created over the relay is routed by usage before its pty spawns,
 * and what the relay hands back is the routed row. Run with: bun test <this file>
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Session } from '../../../../shared/types';

const rows = new Map<string, Session>();
const order: string[] = [];

mock.module('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }));
mock.module('../../../repositories/sessions', () => ({
  getAllSessions: () => [...rows.values()],
  createSession: (session: Session) => { rows.set(session.id, { ...session }); },
  getSession: (id: string) => rows.get(id) ?? null,
}));
mock.module('../../../repositories/session-events', () => ({ createEvent: () => {} }));
mock.module('../../../repositories/groups', () => ({ getAllGroups: () => [{ id: 'g1', workingDir: '/work' }] }));
mock.module('../../../pty-manager', () => ({
  ptyManager: { createSession: (id: string) => { order.push(`spawn:${id}`); } },
}));
mock.module('../../../spawn-retry', () => ({ withSpawnRetry: async () => {}, isTransientSpawnError: () => false }));
mock.module('../../index', () => ({ getApiServer: () => ({ broadcastSessionsUpdated() {} }) }));
mock.module('../../../sound-manager', () => ({ soundManager: { playStartSound() {} } }));
mock.module('../../../providers', () => ({ resolveLaunchProviderId: (p: string) => p }));
mock.module('../../../session-routing', () => ({
  routeNewSessionByUsage: (id: string) => {
    order.push(`route:${id}`);
    const row = rows.get(id);
    if (row) rows.set(id, { ...row, claudeAccountId: 'acct-relief', failoverFromAccountId: 'acct-home' });
  },
  sessionTokenRefreshPending: () => refreshing !== null,
  sessionTokenRefreshSettled: () => refreshing ?? Promise.resolve(),
}));
let refreshing: Promise<void> | null = null;

const { createRemoteSession, remoteSessionEvents } = await import('../remote-sessions');

beforeEach(() => {
  refreshing = null;
  rows.clear();
  order.length = 0;
});

describe('createRemoteSession', () => {
  test('routes by usage before the pty spawns, and returns and emits the routed row', () => {
    const emitted: Session[] = [];
    const listener = (s: Session) => emitted.push(s);
    remoteSessionEvents.on('created', listener);
    const session = createRemoteSession({ groupId: 'g1', name: 'remote', provider: 'claude', launchClaude: true });
    remoteSessionEvents.off('created', listener);

    expect(order).toEqual([`route:${session.id}`, `spawn:${session.id}`]);
    expect(session.claudeAccountId).toBe('acct-relief');
    expect(session.failoverFromAccountId).toBe('acct-home');
    expect(emitted).toEqual([session]);
  });

  test('a token refresh running on the account holds the spawn until it settles', async () => {
    let finish: () => void = () => undefined;
    refreshing = new Promise<void>(resolve => { finish = resolve; });
    const session = createRemoteSession({ groupId: 'g1', name: 'remote', provider: 'claude', launchClaude: true });
    expect(order).toEqual([`route:${session.id}`]);
    finish();
    await Bun.sleep(1);
    expect(order).toEqual([`route:${session.id}`, `spawn:${session.id}`]);
  });
});
