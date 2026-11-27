import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { CrewHireAccount, CrewWindowsSignInResult } from '../../../../../shared/types';
import { WindowsAccountsSignIn, WindowsHireSignIn } from '../WindowsAccountSignIn';

afterEach(cleanup);

const accounts: CrewHireAccount[] = [
  { id: 'a1', label: 'Work Max', needs: 'crew-token' },
  { id: 'a2', label: 'Home Pro', needs: null },
  { id: 'a3', label: 'Spare', needs: 'sign-in' },
];

describe("Sign in for Crew in the hire's account section", () => {
  test('on Windows, an account that needs Crew sign-in gets the sign-in', async () => {
    render(<WindowsHireSignIn platform="win32" accountId="a1" label="Work Max" hireAccounts={async () => accounts} start={async () => ({ ok: true, accountUuid: 'u' })} />);
    expect(await screen.findByText('Sign in for Crew')).toBeTruthy();
  });

  test('an account already signed in for Crew, or none at all, shows nothing', async () => {
    const a = render(<WindowsHireSignIn platform="win32" accountId="a2" label="Home Pro" hireAccounts={async () => accounts} />);
    await act(async () => {});
    expect(a.container.textContent).toBe('');
    const b = render(<WindowsHireSignIn platform="win32" accountId={null} label="x" hireAccounts={async () => accounts} />);
    await act(async () => {});
    expect(b.container.textContent).toBe('');
  });

  test('off Windows nothing is mounted and nothing is asked', async () => {
    let asked = false;
    const { container } = render(<WindowsHireSignIn platform="darwin" accountId="a1" label="Work Max" hireAccounts={async () => ((asked = true), accounts)} />);
    await act(async () => {});
    expect(container.textContent).toBe('');
    expect(asked).toBe(false);
  });

  test('a finished sign-in reads the account again, so the button goes', async () => {
    let list = accounts;
    let end: (r: CrewWindowsSignInResult) => void = () => {};
    render(<WindowsHireSignIn platform="win32" accountId="a1" label="Work Max" hireAccounts={async () => list} start={() => new Promise((r) => (end = r))} />);
    fireEvent.click(await screen.findByText('Sign in for Crew'));
    list = accounts.map((a) => ({ ...a, needs: null }));
    await act(async () => end({ ok: true, accountUuid: 'u' }));
    expect(screen.queryByText('Sign in for Crew')).toBeNull();
  });
});

describe('Sign in for Crew under the Hire account list', () => {
  test('on Windows, each account that needs sign-in is listed with its own sign-in', () => {
    render(<WindowsAccountsSignIn platform="win32" accounts={accounts} onSignedIn={() => {}} />);
    expect(screen.getAllByText('Sign in for Crew')).toHaveLength(2);
    expect(screen.getByText('Work Max')).toBeTruthy();
    expect(screen.getByText('Spare')).toBeTruthy();
    expect(screen.queryByText('Home Pro')).toBeNull();
  });

  test('a finished sign-in asks the modal to read the accounts again', async () => {
    let reloads = 0;
    render(<WindowsAccountsSignIn platform="win32" accounts={[accounts[0]]} onSignedIn={() => void reloads++} start={async () => ({ ok: true, accountUuid: 'u' })} />);
    fireEvent.click(screen.getByText('Sign in for Crew'));
    await act(async () => {});
    expect(reloads).toBe(1);
  });

  test('off Windows, or with every account ready, nothing is mounted', () => {
    expect(render(<WindowsAccountsSignIn platform="linux" accounts={accounts} onSignedIn={() => {}} />).container.textContent).toBe('');
    expect(render(<WindowsAccountsSignIn platform="win32" accounts={[accounts[1]]} onSignedIn={() => {}} />).container.textContent).toBe('');
  });
});
