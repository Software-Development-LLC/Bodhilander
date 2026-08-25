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
import { AccountRow, ClaudeAccountsPanel, LoginBanner, LoginHint } from '../ClaudeAccountsModal';
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
const signedOut = () => document.querySelector('.signed-out-tag') as HTMLElement;

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

  test('an account resolved as signed out is the one told to log in', () => {
    renderRow({ email: null, loggedIn: false });
    expect(signedOut()).toBeTruthy();
    expect(signedOut().getAttribute('aria-label')).toBe('Not signed in');
  });

  // The status follows the resolved login, not the address: on macOS a healthy
  // account records no address, and this is the row where a user would act on
  // being told — wrongly — that none of their accounts had ever logged in.
  test('a logged-in account with no address is not told to log in', () => {
    renderRow({ email: null, loggedIn: true });
    expect(signedOut()).toBeNull();
    expect(screen.getByText('Personal')).toBeTruthy();
  });

  test('an unresolved account makes no claim about its login either way', () => {
    renderRow({ email: null });
    expect(signedOut()).toBeNull();
  });

  // The address used to outrank the status and hide it. That was a safety net
  // for a login state that could not be trusted; now that it can, and now that
  // every login records an address, that rule would hide every logout instead.
  // The two answer different questions, so the row carries both.
  test('a signed-out account keeps its address AND says it is signed out', () => {
    renderRow({ email: 'me@example.com', loggedIn: false });
    expect(screen.getByText('me@example.com')).toBeTruthy();
    expect(signedOut()).toBeTruthy();
  });

  test('the status reads without colour, in the tag and its accessible name', () => {
    renderRow({ email: 'me@example.com', loggedIn: false });
    expect(signedOut().textContent).toContain('not signed in');
    expect(signedOut().getAttribute('title')).toContain('log in again');
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
      // Failover surface (#207): the panel reads the toggles and
      // can reorder or release accounts.
      getAllPreferences: async () => ({}),
      setPreference: async () => {},
      setAccountFallbackOrder: async () => {},
      clearAccountLimit: async () => {},
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

/**
 * The login overlay's copy. It sits on top of the accounts panel, which reads
 * the same config dir main just read, so any claim it makes that main could
 * not confirm puts two answers about one account on screen at once.
 */
describe('LoginHint', () => {
  function hint(props: Partial<React.ComponentProps<typeof LoginHint>> = {}) {
    render(
      <LoginHint
        completed={false}
        verified={false}
        exited={false}
        isMac={false}
        {...props}
      />
    );
    return document.body.textContent ?? '';
  }

  test('a login main actually saw is reported as signed in', () => {
    expect(hint({ completed: true, verified: true })).toContain('signed in');
  });

  // The user can press "I'm logged in" before OAuth finishes: main resolves no
  // login, writes no address, and the panel behind renders "Not yet logged in".
  test('a completion main could not confirm never claims the account is signed in', () => {
    const text = hint({ completed: true, verified: false, isMac: true });
    expect(text).not.toContain('signed in');
    expect(text).toContain('Recorded');
    expect(text).toContain('/login');
  });

  test('an exited login is reported as exited, not as completed', () => {
    const text = hint({ exited: true });
    expect(text).toContain('exited before credentials were saved');
    expect(text).not.toContain('signed in');
  });

  test('a completed login outranks an exit that followed it', () => {
    expect(hint({ completed: true, verified: true, exited: true })).toContain('signed in');
  });

  test('macOS is told about the button it alone is shown', () => {
    expect(hint({ isMac: true })).toContain("I'm logged in");
  });

  test('every other platform is not offered a button it does not have', () => {
    const text = hint({ isMac: false });
    expect(text).not.toContain("I'm logged in");
    expect(text).toContain('/login');
  });
});

/**
 * The banner is the overlay's most emphatic claim, and the one a user acts on
 * by closing the window. It may only appear for a login main actually found.
 */
describe('LoginBanner', () => {
  const banner = () => document.querySelector('.completion-banner');

  test('a verified completion is the only thing called saved', () => {
    render(<LoginBanner completed verified />);
    expect(banner()!.textContent).toContain('Login saved');
  });

  // The user can press "I'm logged in" before OAuth finishes. Main then finds
  // no login, and the panel behind this overlay says so — a banner here would
  // be the same account described two ways on one screen.
  test('a completion main could not confirm is never called saved', () => {
    render(<LoginBanner completed verified={false} />);
    expect(banner()).toBeNull();
    expect(document.body.textContent).not.toContain('Login saved');
  });

  test('nothing is claimed before the login completes at all', () => {
    render(<LoginBanner completed={false} verified />);
    expect(banner()).toBeNull();
  });

  test('an unstarted login claims nothing either', () => {
    render(<LoginBanner completed={false} verified={false} />);
    expect(banner()).toBeNull();
  });
});
