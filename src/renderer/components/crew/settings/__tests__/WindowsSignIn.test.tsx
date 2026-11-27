import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { CrewWindowsSignInResult } from '../../../../../shared/types';
import { WindowsSignIn } from '../WindowsSignIn';

afterEach(cleanup);

function mount(over: Partial<React.ComponentProps<typeof WindowsSignIn>> = {}) {
  let end: (r: CrewWindowsSignInResult) => void = () => {};
  const codes: string[] = [];
  let cancels = 0;
  render(
    <WindowsSignIn
      accountId="a1"
      label="Work Max"
      start={() => new Promise((r) => (end = r))}
      sendCode={async (c) => (codes.push(c), true)}
      cancel={async () => void cancels++}
      {...over}
    />,
  );
  return { end: (r: CrewWindowsSignInResult) => act(async () => end(r)), codes, cancels: () => cancels };
}

describe('Sign in for Crew on Windows', () => {
  test('opens the browser, then takes the pasted code', async () => {
    const t = mount();
    fireEvent.click(screen.getByText('Sign in for Crew'));
    await screen.findByText(/Your browser opened/);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '  abc-123  ' } });
    fireEvent.click(screen.getByText('Send code'));
    await act(async () => {});
    expect(t.codes).toEqual(['abc-123']);
    await t.end({ ok: true, accountUuid: 'u1' });
    expect(screen.getByText('Work Max is signed in for Crew.')).toBeTruthy();
  });

  test('an empty code is not sent', async () => {
    const t = mount();
    fireEvent.click(screen.getByText('Sign in for Crew'));
    await screen.findByText(/Your browser opened/);
    fireEvent.click(screen.getByText('Send code'));
    expect(t.codes).toEqual([]);
  });

  test('cancel stops the sign-in and says so', async () => {
    const t = mount();
    fireEvent.click(screen.getByText('Sign in for Crew'));
    fireEvent.click(await screen.findByText('Cancel'));
    await act(async () => {});
    expect(t.cancels()).toBe(1);
    await t.end({ ok: false, reason: 'cancelled' });
    expect(screen.getByText('Sign-in was cancelled.')).toBeTruthy();
  });

  test('a token for another account is refused in words', async () => {
    const t = mount();
    fireEvent.click(screen.getByText('Sign in for Crew'));
    await t.end({ ok: false, reason: 'wrong-account' });
    expect(screen.getByText(/a different Claude account/)).toBeTruthy();
  });
});
