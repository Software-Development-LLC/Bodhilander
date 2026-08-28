/**
 * The in-window account-switch notice.
 *
 * What is worth asserting here is not that it renders, but that it cannot say
 * a switch happened when none did. "Moved to Work" over a session still stuck
 * on a spent account is the failure this whole feature would be judged by, and
 * the blocked cases are exactly where that sentence could get printed by
 * accident.
 */
import { describe, expect, test } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { FailoverNotice } from '../FailoverNotice';
import { AccountFailoverEvent, ClaudeAccount } from '../../../shared/types';

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

function notice(overrides: Partial<AccountFailoverEvent>) {
  cleanup();
  const event: AccountFailoverEvent = {
    reason: 'limit',
    from: account('primary', 'Personal'),
    to: account('backup', 'Work'),
    sessionIds: ['s1', 's2'],
    resetAt: null,
    ...overrides,
  };
  render(<FailoverNotice event={event} onDismiss={() => {}} onOpenAccounts={() => {}} />);
  return screen.getByRole('status').textContent ?? '';
}

describe('FailoverNotice', () => {
  test('names both accounts and how many sessions moved', () => {
    const text = notice({});
    expect(text).toContain('Personal');
    expect(text).toContain('Work');
    expect(text).toContain('2 sessions moved');
  });

  test('says when the spent account comes back, if the CLI said', () => {
    const resetAt = new Date();
    resetAt.setHours(resetAt.getHours() + 2, 30, 0, 0);
    expect(notice({ resetAt })).toContain('back at');
  });

  test('never claims a move when every account is spent', () => {
    const text = notice({ to: null, sessionIds: [], blocked: 'no-healthy-account' });
    expect(text).toContain('Every other account is limited');
    expect(text).not.toContain('moved to');
  });

  test('reads as a return, not a switch, on the way home', () => {
    const text = notice({
      reason: 'failback',
      from: account('backup', 'Work'),
      to: account('primary', 'Personal'),
      sessionIds: ['s1'],
    });
    expect(text).toContain('Back on your own account');
    expect(text).toContain('1 session moved back');
  });
});
