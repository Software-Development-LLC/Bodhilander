/**
 * TerminalHeader's account slot (#165).
 *
 * The header is mounted for every open session at once, so the indicator has
 * to be optional in the strict sense: an install with no Claude accounts must
 * get back exactly the header it had before accounts existed, with no empty
 * chrome standing in for the feature.
 *
 * Run with: bun test src/renderer/components/__tests__/TerminalHeader.test.tsx
 */
import React from 'react';
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import TerminalHeader from '../TerminalHeader';
import { SessionAccountIndicatorProps } from '../SessionAccountIndicator';
import { ClaudeAccount, Session } from '../../../shared/types';

afterEach(cleanup);

beforeEach(() => {
  // useSessionStats fires on mount; without this the header throws before it
  // ever renders the slot under test.
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getSessionStats: async () => null,
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const session = {
  id: 's1', name: 'login flow', groupId: 'g1', order: 0,
  state: 'running', shellType: 'claude', provider: 'claude',
  workingDir: '/Users/will/Work/Repos/Bodhilander',
  claudeAccountId: null,
} as Session;

const noop = () => {};

function renderHeader(account?: SessionAccountIndicatorProps | null) {
  render(
    <TerminalHeader
      session={session}
      account={account}
      onRename={noop}
      onRestart={noop}
      onStop={noop}
      onClose={noop}
    />
  );
}

const accountProps: SessionAccountIndicatorProps = {
  liveAccount: { id: 'a1', label: 'Work', email: null, color: '#61afef' } as ClaudeAccount,
  assignedAccount: { id: 'a1', label: 'Work', email: null, color: '#61afef' } as ClaudeAccount,
  isRunning: true,
  liveAccountUnknown: false,
  isOverride: false,
  onApplySwitch: noop,
};

describe('TerminalHeader', () => {
  test('without an account the header looks exactly as it did before accounts', () => {
    renderHeader();
    expect(document.querySelector('.header-account')).toBeNull();
    expect(screen.getByText('login flow')).toBeTruthy();
    expect(screen.getByLabelText('Restart session')).toBeTruthy();
  });

  test('an explicit null is the same as omitting it', () => {
    renderHeader(null);
    expect(document.querySelector('.header-account')).toBeNull();
  });

  test('with an account the indicator renders inside the header chrome', () => {
    renderHeader(accountProps);
    const indicator = document.querySelector('.terminal-header .header-account');
    expect(indicator).toBeTruthy();
    expect(screen.getByText('Work')).toBeTruthy();
  });

  test('the indicator sits after the path, so the path is what gets squeezed', () => {
    renderHeader(accountProps);
    const header = document.querySelector('.terminal-header')!;
    const children = Array.from(header.children);
    const path = children.findIndex(el => el.classList.contains('header-path'));
    const indicator = children.findIndex(el => el.classList.contains('header-account'));
    expect(path).toBeGreaterThanOrEqual(0);
    expect(indicator).toBe(path + 1);
  });
});
