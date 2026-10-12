/**
 * The session header's active-account indicator (#165).
 *
 * The property under test is the one #164 made expensive: the indicator names
 * the account the pty is ACTUALLY running under, never the database
 * assignment. When the two disagree it must say so in words — a switch that
 * silently reads as applied is how a live session kept billing the old account
 * while every surface claimed otherwise.
 *
 * Run with: bun test src/renderer/components/__tests__/SessionAccountIndicator.test.tsx
 */
import React from 'react';
import { describe, expect, test, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SessionAccountIndicator, SessionAccountIndicatorProps } from '../SessionAccountIndicator';
import { ClaudeAccount } from '../../../shared/types';

afterEach(cleanup);

function account(id: string, label: string): ClaudeAccount {
  return { id, label, email: `${id}@example.com`, color: '#61afef' } as ClaudeAccount;
}

const WORK = account('a1', 'Work');
const PERSONAL = account('a2', 'Personal');

function renderIndicator(overrides: Partial<SessionAccountIndicatorProps> = {}) {
  let applied = 0;
  const props: SessionAccountIndicatorProps = {
    liveAccount: WORK,
    assignedAccount: WORK,
    isRunning: true,
    liveAccountUnknown: false,
    isOverride: false,
    onApplySwitch: () => { applied++; },
    ...overrides,
  };
  render(<SessionAccountIndicator {...props} />);
  return { applied: () => applied };
}

const root = () => document.querySelector('.header-account') as HTMLElement;
const chipTitle = () => document.querySelector('.account-chip')!.getAttribute('title')!;

describe('SessionAccountIndicator', () => {
  test('a settled live session names its account and offers nothing to do', () => {
    renderIndicator();
    expect(screen.getByText('Work')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(chipTitle()).toContain('running under this account');
    expect(root().className).not.toContain('is-idle');
  });

  test('a pending switch names the LIVE account and spells the target out in words', () => {
    const { applied } = renderIndicator({ assignedAccount: PERSONAL });

    // The chip stays on Work: that is what the pty is still billing.
    expect(screen.getByText('Work')).toBeTruthy();

    // Nothing about the pending state depends on colour or a glyph, and
    // nothing is phrased as an operation already under way — the switch is
    // stalled until someone restarts, and the text says which.
    expect(screen.getByText(/Restart to use Personal/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('Switching to');
    expect(chipTitle()).toContain('still running under this account');

    const apply = screen.getByRole('button');
    fireEvent.click(apply);
    expect(applied()).toBe(1);
  });

  test('both sides of a switch are named the way the chip names an account', () => {
    // The scenario emails were added for: two logins, one label. If the target
    // is named by label alone, "still running under Work / restart to use
    // Work" tells the user nothing about what is changing.
    const other = { ...account('a3', 'Work'), email: 'other@example.com' } as ClaudeAccount;
    renderIndicator({ liveAccount: WORK, assignedAccount: other });

    expect(screen.getByText(/Restart to use Work \(other@example\.com\)/)).toBeTruthy();
    expect(screen.getByRole('button').getAttribute('aria-label'))
      .toBe('Restart now to run under Work (other@example.com)');
    expect(chipTitle()).toContain('a1@example.com');
  });

  test('a switch back to the legacy login still names a target', () => {
    renderIndicator({ assignedAccount: null });
    expect(screen.getByText(/Restart to use the default login/)).toBeTruthy();
  });

  test('a deleted account with nothing assigned still offers the way out', () => {
    // Deleting the default account does not promote a survivor, so the session
    // resolves to no assignment at all. Comparing ids alone makes that read as
    // "nothing pending" — the user is told their account is gone and handed no
    // button. liveAccountUnknown has to be its own trigger.
    const { applied } = renderIndicator({
      liveAccount: null,
      assignedAccount: null,
      liveAccountUnknown: true,
    });

    expect(screen.getByText('Removed account')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(applied()).toBe(1);
  });

  test('a stopped session forecasts the assigned account instead', () => {
    renderIndicator({ isRunning: false, liveAccount: WORK, assignedAccount: PERSONAL });
    expect(screen.getByText('Personal')).toBeTruthy();
    expect(screen.queryByText('Work')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(chipTitle()).toContain('will run under this account when started');
    expect(root().className).toContain('is-idle');
  });

  test('the assignment scope reaches the tooltip both ways', () => {
    renderIndicator({ isRunning: false, isOverride: true });
    expect(chipTitle()).toContain('session override');

    cleanup();
    renderIndicator({ isRunning: false, isOverride: false });
    expect(chipTitle()).toContain('inherited from group or default');
  });

  test('a pty left on a deleted account says so and still offers Apply', () => {
    renderIndicator({ liveAccount: null, assignedAccount: PERSONAL, liveAccountUnknown: true });
    expect(screen.getByText('Removed account')).toBeTruthy();
    expect(screen.getByText(/Restart to use Personal/)).toBeTruthy();
    expect(screen.getByRole('button')).toBeTruthy();
  });
});
