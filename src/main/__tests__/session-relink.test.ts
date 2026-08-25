/**
 * The launch guard for restored sessions.
 *
 * A needs-relink session must never reach PtyManager, which throws on a
 * missing cwd; every other state must pass through untouched.
 *
 * Run with: bun test src/main/__tests__/session-relink.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { launchBlockReason, needsRelink, NEEDS_RELINK_STATE } from '../session-relink';

describe('needsRelink', () => {
  test('is true only for the restored-elsewhere state', () => {
    expect(needsRelink(NEEDS_RELINK_STATE)).toBe(true);
    for (const state of ['idle', 'working', 'waiting', 'error', 'stopped', '', null, undefined]) {
      expect(needsRelink(state)).toBe(false);
    }
  });
});

describe('launchBlockReason', () => {
  test('blocks a needs-relink session and names the directory', () => {
    const reason = launchBlockReason({ name: 'Auth refactor', state: NEEDS_RELINK_STATE, workingDir: '/gone/here' });
    expect(reason).toContain('Auth refactor');
    expect(reason).toContain('/gone/here');
  });

  test('says something usable even when the directory is blank', () => {
    const reason = launchBlockReason({ name: 'S', state: NEEDS_RELINK_STATE, workingDir: '' });
    expect(reason).toContain('working directory');
  });

  test('lets every other state through', () => {
    for (const state of ['idle', 'working', 'waiting', 'error', 'stopped']) {
      expect(launchBlockReason({ name: 'S', state, workingDir: '/tmp' })).toBeNull();
    }
  });

  test('lets an unknown session through, so the launcher decides', () => {
    expect(launchBlockReason(undefined)).toBeNull();
  });
});
