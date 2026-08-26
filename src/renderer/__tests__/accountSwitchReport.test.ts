/**
 * What an account switch says when it restarts nothing (#214).
 *
 * The bug these cover is silence, so the assertions are about a sentence
 * existing and being true — not about its exact wording. Two things matter
 * enough to pin down: that the one case which speaks for itself stays quiet,
 * and that a session pinned in place is TOLD it is pinned, because that is the
 * consequence the click has and cannot be seen anywhere in the UI.
 *
 * Run with: bun test src/renderer/__tests__
 */
import { describe, expect, test } from 'bun:test';
import { reportGroupSwitch, reportSessionSwitch } from '../accountSwitchReport';
import { AccountSwitchResult, ClaudeAccount } from '../../shared/types';

function account(id: string, label: string): ClaudeAccount {
  return {
    id,
    label,
    configDir: `/tmp/${id}`,
    email: null,
    color: '#888888',
    isDefault: false,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    lastUsedAt: null,
    fallbackRank: 0,
    limitedUntil: null,
    limitedAt: null,
  };
}

const WORK = account('work', 'Work');

function result(over: Partial<AccountSwitchResult> & {
  outcome?: Partial<AccountSwitchResult['outcome']>;
} = {}): AccountSwitchResult {
  return {
    affectedSessionIds: over.affectedSessionIds ?? [],
    outcome: {
      account: WORK,
      unchangedSessionIds: [],
      overriddenSessionIds: [],
      ...over.outcome,
    },
  };
}

describe('reportSessionSwitch', () => {
  test('says nothing when the session is about to restart in front of the user', () => {
    const report = reportSessionSwitch(
      result({ affectedSessionIds: ['s1'] }),
      { targetName: 'Predicate Permissions', pickedAccountId: 'work', liveAffected: ['s1'] },
    );

    expect(report).toBeNull();
  });

  test('a stopped session is told when the account will take effect', () => {
    const report = reportSessionSwitch(
      result({ affectedSessionIds: ['s1'] }),
      { targetName: 'Predicate Permissions', pickedAccountId: 'work', liveAffected: [] },
    );

    expect(report).not.toBeNull();
    expect(report?.account).toBe(WORK);
    expect(`${report?.prefix}${report?.suffix}`).toContain('Predicate Permissions');
    expect(report?.suffix).toContain('start');
  });

  test('picking the account a session already inherits says it is now pinned', () => {
    // The exact shape of #214: the click registered, the row was written, the
    // effective account did not move — and the session quietly stopped
    // following its group, which nothing else in the UI reveals.
    const report = reportSessionSwitch(
      result({ outcome: { unchangedSessionIds: ['s1'] } }),
      { targetName: 'Session 1', pickedAccountId: 'work', liveAffected: [] },
    );

    expect(report?.tone).toBe('muted');
    expect(report?.suffix).toContain('pinned');
    expect(report?.suffix).toContain('group');
  });

  test('clearing an override that changed nothing does not claim a pin', () => {
    const report = reportSessionSwitch(
      result({ outcome: { unchangedSessionIds: ['s1'] } }),
      { targetName: 'Session 1', pickedAccountId: null, liveAffected: [] },
    );

    expect(report?.suffix).not.toContain('pinned');
    expect(report?.prefix).toContain('group');
  });
});

describe('reportGroupSwitch', () => {
  test('defers to the restart prompt when one is about to appear', () => {
    const report = reportGroupSwitch(
      result({ affectedSessionIds: ['a', 'b'] }),
      { targetName: 'Api Service', pickedAccountId: 'work', liveAffected: ['a', 'b'] },
    );

    expect(report).toBeNull();
  });

  test('an empty group still confirms what it now uses', () => {
    const report = reportGroupSwitch(
      result(),
      { targetName: 'Api Service', pickedAccountId: 'work', liveAffected: [] },
    );

    expect(report?.prefix).toContain('Api Service');
    expect(report?.account).toBe(WORK);
  });

  test('sessions that moved but are stopped are reported, not silently dropped', () => {
    const report = reportGroupSwitch(
      result({ affectedSessionIds: ['a', 'b'] }),
      { targetName: 'Api Service', pickedAccountId: 'work', liveAffected: [] },
    );

    expect(report?.suffix).toContain('2 sessions');
    expect(report?.suffix).toContain('stopped');
  });

  test('distinguishes sessions already on the account from ones pinned elsewhere', () => {
    const report = reportGroupSwitch(
      result({ outcome: {
        unchangedSessionIds: ['already', 'pinned-1', 'pinned-2'],
        overriddenSessionIds: ['pinned-1', 'pinned-2'],
      } }),
      { targetName: 'Api Service', pickedAccountId: 'work', liveAffected: [] },
    );

    expect(report?.suffix).toContain('1 session was already on it');
    expect(report?.suffix).toContain('2 sessions have their own account');
    expect(report?.suffix).toContain('nothing moved');
  });

  test('reports only the reason that applies when every session is pinned', () => {
    const report = reportGroupSwitch(
      result({ outcome: {
        unchangedSessionIds: ['p1'],
        overriddenSessionIds: ['p1'],
      } }),
      { targetName: 'Api Service', pickedAccountId: 'work', liveAffected: [] },
    );

    expect(report?.suffix).not.toContain('already on it');
    expect(report?.suffix).toContain('own account');
  });
});
