import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { HireModal, type HireModalApi } from '../HireModal';
import type { CrewHireAccount, CrewHireInput, CrewHireResult } from '../../../../shared/types';

afterEach(cleanup);

const accounts: CrewHireAccount[] = [
  { id: 'acc-1', label: 'Work', needs: null },
  { id: 'acc-2', label: 'Personal', needs: null },
  { id: 'acc-3', label: 'Spare', needs: 'crew-token' },
];

function api(answer: CrewHireResult = { ok: true, hireId: 'h-new' }): HireModalApi & { sent: CrewHireInput[] } {
  const sent: CrewHireInput[] = [];
  return {
    sent,
    listRoles: async () => [
      { roleId: 'care-po', name: 'care-po' },
      { roleId: 'fresh-po', name: 'fresh-po' },
    ],
    hireAccounts: async () => accounts,
    createHire: async (input) => (sent.push(input), answer),
  };
}

async function fill(): Promise<void> {
  await screen.findByRole('option', { name: 'fresh-po' });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'fresh-po' } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fresh PO' } });
  fireEvent.change(screen.getByLabelText('Repos'), { target: { value: 'acme/app\n\n acme/web , acme/api' } });
  fireEvent.change(screen.getByLabelText('Claude account'), { target: { value: 'acc-2' } });
}

describe('the Hire form', () => {
  test('sends the role, name, one repo per entry and the chosen account, then hands back the new hire', async () => {
    const a = api();
    const hired: string[] = [];
    render(<HireModal api={a} onHired={(id) => hired.push(id)} onClose={() => {}} />);
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Hire' }));
    await waitFor(() => expect(hired).toEqual(['h-new']));
    expect(a.sent).toEqual([{ name: 'Fresh PO', roleId: 'fresh-po', repos: ['acme/app', 'acme/web', 'acme/api'], accountId: 'acc-2' }]);
  });

  test("Hire stays off until a role, a name and an account are picked", async () => {
    render(<HireModal api={api()} onHired={() => {}} onClose={() => {}} />);
    await screen.findByRole('option', { name: 'fresh-po' });
    const hire = screen.getByRole('button', { name: 'Hire' }) as HTMLButtonElement;
    expect(hire.disabled).toBe(true);
    await fill();
    expect(hire.disabled).toBe(false);
  });

  test("a refusal is shown and the form stays open with what was typed", async () => {
    const hired: string[] = [];
    render(<HireModal api={api({ ok: false, error: 'roleId is not a known role' })} onHired={(id) => hired.push(id)} onClose={() => {}} />);
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Hire' }));
    expect((await screen.findByRole('alert')).textContent).toContain('roleId is not a known role');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Fresh PO');
    expect(hired).toEqual([]);
  });

  test('a hire that was sent but not yet answered still hands back its id, so it can show as provisioning', async () => {
    const hired: string[] = [];
    render(<HireModal api={api({ ok: false, hireId: 'h-late', error: "Crew Hub hasn't answered yet." })} onHired={(id) => hired.push(id)} onClose={() => {}} />);
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Hire' }));
    await waitFor(() => expect(hired).toEqual(['h-late']));
  });

  test('with no synced roles it says so instead of offering an empty list', async () => {
    const a = { ...api(), listRoles: async () => [] };
    render(<HireModal api={a} onHired={() => {}} onClose={() => {}} />);
    expect((await screen.findByText(/No roles have synced/)).textContent).toBeTruthy();
  });

  test('an account Crew cannot run on is shown with what it needs, and cannot be picked', async () => {
    render(<HireModal api={api()} onHired={() => {}} onClose={() => {}} />);
    const spare = (await screen.findByRole('option', { name: 'Spare (Set up Crew sign-in)' })) as HTMLOptionElement;
    expect(spare.disabled).toBe(true);
    expect((screen.getByRole('option', { name: 'Work' }) as HTMLOptionElement).disabled).toBe(false);
  });
});

describe('the Hire form on Windows', () => {
  test('an account that needs Crew sign-in gets Sign in for Crew under the account list', async () => {
    const w = window as unknown as { electronAPI?: unknown };
    const before = w.electronAPI;
    w.electronAPI = { platform: 'win32' };
    try {
      render(<HireModal api={api()} onHired={() => {}} onClose={() => {}} />);
      expect(await screen.findByText('Sign in for Crew')).toBeTruthy();
      expect(screen.getByRole('list', { name: 'Accounts to sign in for Crew' }).textContent).toContain('Spare');
    } finally {
      w.electronAPI = before;
    }
  });
});
