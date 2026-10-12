/**
 * The in-window report of a manual account switch (#214).
 *
 * The shell is shared with the failover notice, so what is worth asserting
 * here is the join: the account has to be named inside the sentence, and the
 * whole thing has to reach a screen reader as one announcement rather than as
 * a fragment either side of an unlabelled chip.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { AccountSwitchNotice } from '../AccountSwitchNotice';
import { AccountSwitchReport } from '../../accountSwitchReport';
import { ClaudeAccount } from '../../../shared/types';

afterEach(cleanup);

const work = {
  id: 'a-work', label: 'Work', email: null, color: '#61afef',
  configDir: '/cfg/work', isDefault: false,
} as ClaudeAccount;

function show(report: Partial<AccountSwitchReport> = {}): string {
  render(
    <AccountSwitchNotice
      report={{
        tone: 'muted',
        prefix: '“Session 1” was already using ',
        account: work,
        suffix: ' — it is now pinned to that account.',
        ...report,
      }}
      onDismiss={() => {}}
    />,
  );
  return screen.getByRole('status').textContent ?? '';
}

describe('AccountSwitchNotice', () => {
  test('reads as one sentence with the account named inside it', () => {
    expect(show()).toContain('“Session 1” was already using Work — it is now pinned');
  });

  test('names the no-account case rather than leaving a gap mid-sentence', () => {
    const text = show({ account: null, prefix: 'This group now uses ', suffix: '.' });
    expect(text).toContain('This group now uses');
    // AccountChip's own empty label — asserted as non-empty rather than
    // verbatim, since which words it uses is that component's business.
    expect(text.replace('This group now uses', '').replace('.', '').trim().length).toBeGreaterThan(0);
  });

  test('is dismissible', () => {
    show();
    expect(screen.getByLabelText('Dismiss')).toBeDefined();
  });
});
