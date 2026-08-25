/**
 * The accounts panel's row — which accounts are actually in use (#165).
 *
 * Deleting an account unbinds every session on it, and before this the list
 * gave no way to tell which rows that would disturb. The in-use pill has to be
 * legible next to the pre-existing `default` tag without leaning on colour, so
 * these tests pin the count and the accessible name, not the styling.
 *
 * AccountRow is tested directly: the panel around it self-fetches, and
 * stubbing four IPC methods to reach the same markup buys nothing. The panel
 * itself is stood up only for the delete confirmation, which is the one thing
 * the row does not own.
 *
 * Run with: bun test src/renderer/components/__tests__/ClaudeAccountsModal.test.tsx
 */
import React from 'react';
import { describe, expect, test, afterEach } from 'bun:test';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AccountRow, ClaudeAccountsPanel } from '../ClaudeAccountsModal';
import { ClaudeAccount } from '../../../shared/types';

afterEach(cleanup);

function account(overrides: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return {
    id: 'a1',
    label: 'Personal',
    email: 'me@example.com',
    color: '#61afef',
    isDefault: false,
    ...overrides,
  } as ClaudeAccount;
}

function renderRow(overrides: Partial<ClaudeAccount> = {}, runningSessions = 0) {
  let deleted = 0;
  let madeDefault = 0;
  render(
    <AccountRow
      account={account(overrides)}
      runningSessions={runningSessions}
      onMakeDefault={() => { madeDefault++; }}
      onDelete={() => { deleted++; }}
    />
  );
  return { deleted: () => deleted, madeDefault: () => madeDefault };
}

const inUse = () => document.querySelector('.in-use-tag') as HTMLElement;

describe('AccountRow', () => {
  test('names the account through the shared chip', () => {
    renderRow();
    expect(document.querySelector('.account-chip-md')).toBeTruthy();
    expect(screen.getByText('Personal')).toBeTruthy();
    expect(screen.getByText('me@example.com')).toBeTruthy();
  });

  test('an idle account carries no usage badge at all', () => {
    renderRow({}, 0);
    expect(inUse()).toBeNull();
  });

  test('an account resolved as logged out is the one told to log in', () => {
    renderRow({ email: null, loggedIn: false });
    expect(screen.getByText('Not yet logged in')).toBeTruthy();
  });

  // The status follows the resolved login, not the address: on macOS a healthy
  // account records no address, and this is the row where a user would act on
  // being told — wrongly — that none of their accounts had ever logged in.
  test('a logged-in account with no address is not told to log in', () => {
    renderRow({ email: null, loggedIn: true });
    expect(screen.queryByText('Not yet logged in')).toBeNull();
    expect(screen.getByText('Personal')).toBeTruthy();
  });

  test('an unresolved account makes no claim about its login either way', () => {
    renderRow({ email: null });
    expect(screen.queryByText('Not yet logged in')).toBeNull();
  });

  test('an address, once known, outranks the status it would replace', () => {
    renderRow({ email: 'me@example.com', loggedIn: false });
    expect(screen.getByText('me@example.com')).toBeTruthy();
    expect(screen.queryByText('Not yet logged in')).toBeNull();
  });

  test('usage is reported as a number, not a tint', () => {
    renderRow({}, 2);
    expect(inUse().textContent).toContain('2');
    expect(inUse().getAttribute('aria-label')).toBe('In use by 2 running sessions');
  });

  test('a single session reads in the singular', () => {
    renderRow({}, 1);
    expect(inUse().getAttribute('aria-label')).toBe('In use by 1 running session');
    expect(inUse().getAttribute('title')).toContain('session is');
  });

  test('default and in-use are two distinct tags, not one merged state', () => {
    renderRow({ isDefault: true }, 1);
    const tag = document.querySelector('.default-tag') as HTMLElement;
    expect(tag).toBeTruthy();
    expect(inUse()).toBeTruthy();
    expect(tag === inUse()).toBe(false);
    // The default account has nothing to promote it to.
    expect(screen.queryByText('Make default')).toBeNull();
  });

  test('the row actions report up rather than acting themselves', () => {
    const { deleted, madeDefault } = renderRow();
    fireEvent.click(screen.getByText('Make default'));
    fireEvent.click(screen.getByText('Delete'));
    expect(madeDefault()).toBe(1);
    expect(deleted()).toBe(1);
  });
});

/**
 * The panel is stood up for one thing the row cannot answer: the delete
 * confirmation. The panel already knows how many ptys are on an account — it
 * renders the number two inches above the button — and deleting removes the
 * config dir out from under them, so withholding that from the dialog while it
 * says "sessions themselves are kept" is the one place that count had a job.
 */
describe('ClaudeAccountsPanel delete confirmation', () => {
  const listed: ClaudeAccount[] = [account({ id: 'a1', label: 'Personal' })];

  function stubApi(live: Record<string, { accountId: string | null }>) {
    const deleted: string[] = [];
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      listAccounts: async () => listed,
      getLiveAccounts: async () => live,
      onPtyLiveAccount: () => () => {},
      onAccountLoginCompleted: () => () => {},
      deleteAccount: async (id: string) => { deleted.push(id); },
      setDefaultAccount: async () => true,
      startAccountLogin: async () => ({ account: listed[0], ptyId: 'p' }),
      cancelAccountLogin: async () => {},
      platform: 'darwin',
      homedir: '/home',
    };
    return deleted;
  }

  async function openPanel(live: Record<string, { accountId: string | null }>) {
    const deleted = stubApi(live);
    const messages: string[] = [];
    (window as unknown as { confirm: (m: string) => boolean }).confirm = (m: string) => {
      messages.push(m);
      return true;
    };
    await act(async () => { render(<ClaudeAccountsPanel />); });
    return { deleted, messages };
  }

  test('names the sessions that will lose their account directory', async () => {
    const { deleted, messages } = await openPanel({
      s1: { accountId: 'a1' },
      s2: { accountId: 'a1' },
      s3: { accountId: 'other' },
    });

    await act(async () => { fireEvent.click(screen.getByText('Delete')); });

    expect(messages[0]).toContain('2 running sessions are using this account right now');
    expect(messages[0]).toContain('their account directory goes away');
    expect(deleted).toEqual(['a1']);
  });

  test('says nothing about running sessions when there are none', async () => {
    const { messages } = await openPanel({ s3: { accountId: 'other' } });

    await act(async () => { fireEvent.click(screen.getByText('Delete')); });

    expect(messages[0]).not.toContain('running session');
  });
});
