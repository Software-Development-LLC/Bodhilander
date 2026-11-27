import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { HireDetail, type HireDetailApi } from '../HireDetail';
import type { AccountUsage, ClaudeAccount, CrewEditResult, CrewHireDetail, CrewHireUsage } from '../../../../shared/types';

afterEach(cleanup);

const NOW = Date.parse('2026-11-27T12:00:00Z');

const detail = (over: Partial<CrewHireDetail> = {}): CrewHireDetail => ({
  hireId: 'h1',
  name: 'Fresh PO',
  roleId: 'fresh-po',
  state: 'active',
  activity: 'idle',
  cause: null,
  accountLabel: 'Work',
  repos: ['bodhi-fresh'],
  routines: [{ routineId: 'r1', cron: '0 9 * * 1-5', timezone: 'America/Chicago', prompt: 'Morning standup', lastFired: null }],
  dailyTokenCap: null,
  skillBundleId: 'bundle-1',
  skillBundleHash: 'abcdef0123456789',
  accountId: 'acc-1',
  accountEmail: 'w@x.com',
  ...over,
});

const accounts = [
  { id: 'acc-1', label: 'Work', configDir: '/d/1', email: 'w@x.com', color: '#000' },
  { id: 'acc-2', label: 'Personal', configDir: '/d/2', email: 'p@x.com', color: '#000' },
] as ClaudeAccount[];

const accountUsage: AccountUsage = {
  accountId: 'acc-1',
  fiveHour: { pct: 42, resetsAt: NOW + 3_600_000, observedAt: NOW - 1000 },
  sevenDay: { pct: 17, resetsAt: NOW + 86_400_000, observedAt: NOW - 1000 },
  source: 'poll',
  observedAt: NOW - 1000,
  unavailable: null,
};

/** Five runs across two home machines, summed by the Hub. */
const fiveRuns: CrewHireUsage = { available: true, since: NOW - 7 * 86_400_000, inputTokens: 120_000, outputTokens: 30_500, cacheCreationTokens: 4_000, records: 5 };

function api(over: Partial<HireDetailApi> = {}): HireDetailApi & { edits: unknown[][] } {
  const edits: unknown[][] = [];
  const ok = async (): Promise<CrewEditResult> => ({ ok: true });
  return {
    edits,
    getHire: async () => detail(),
    getHireUsage: async () => fiveRuns,
    listAccounts: async () => accounts,
    getAccountUsage: async () => ({ 'acc-1': accountUsage }),
    setDailyCap: async (...args) => (edits.push(['cap', ...args]), ok()),
    setRepos: async (...args) => (edits.push(['repos', ...args]), ok()),
    changeAccount: async (...args) => (edits.push(['account', ...args]), ok()),
    letGo: async (...args) => (edits.push(['letGo', ...args]), ok()),
    signInAgain: async (...args) => (edits.push(['signIn', ...args]), ok()),
    ...over,
  };
}

const tokens = () => document.querySelector('.crew-detail__tokens') as HTMLElement;

describe("the hire's usage", () => {
  test('shows the 7-day tokens next to the account readings, as tokens, never a cost or a percent', async () => {
    render(<HireDetail hireId="h1" api={api()} now={() => NOW} />);
    await screen.findByText('154,500 tokens');
    const text = tokens().textContent ?? '';
    expect(text).toContain('120,000');
    expect(text).toContain('4,000');
    expect(text).toContain('30,500');
    expect(text).not.toMatch(/\$|%|USD|cost/i);
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByText('17%')).toBeTruthy();
  });

  test('a failed read renders not available, not 0', async () => {
    render(<HireDetail hireId="h1" api={api({ getHireUsage: async () => ({ available: false, reason: 'unreachable' }) })} now={() => NOW} />);
    await screen.findByText(/not available/);
    expect(tokens().textContent).not.toMatch(/\b0\b/);
    expect(tokens().textContent).not.toContain('tokens');
  });

  test('a read that throws is not available too', async () => {
    render(<HireDetail hireId="h1" api={api({ getHireUsage: async () => { throw new Error('ipc gone'); } })} now={() => NOW} />);
    await screen.findByText(/not available/);
    expect(tokens().textContent).not.toMatch(/\b0\b/);
  });

  test('before the read answers it claims nothing', async () => {
    render(<HireDetail hireId="h1" api={api({ getHireUsage: () => new Promise(() => {}) })} now={() => NOW} />);
    await screen.findByText('Fresh PO');
    expect(tokens().textContent).not.toContain('tokens');
    expect(tokens().textContent).not.toContain('not available');
    expect(tokens().textContent).not.toMatch(/\b0\b/);
  });

  test('is read again each time the page opens on a hire', async () => {
    let reads = 0;
    const a = api({ getHireUsage: async () => ((reads += 1), fiveRuns) });
    const { rerender } = render(<HireDetail hireId="h1" api={a} now={() => NOW} />);
    await screen.findByText('154,500 tokens');
    rerender(<HireDetail hireId="h2" api={a} now={() => NOW} />);
    await waitFor(() => expect(reads).toBe(2));
  });
});

describe('the rest of the hire page', () => {
  test('a hire not on this machine says so', async () => {
    render(<HireDetail hireId="h1" api={api({ getHire: async () => null })} now={() => NOW} />);
    await screen.findByText("This hire isn't on this machine.");
  });

  test('shows repos, routines, the skill bundle pin and the cap off by default', async () => {
    render(<HireDetail hireId="h1" api={api()} now={() => NOW} />);
    await screen.findByText('Morning standup');
    expect((screen.getByLabelText('Repos') as HTMLTextAreaElement).value).toBe('bodhi-fresh');
    expect(screen.getByText(/abcdef012345/)).toBeTruthy();
    expect((screen.getByLabelText('Daily token cap') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Off')).toBeTruthy();
  });

  test('sets a daily cap, and refuses one that is not a whole number', async () => {
    const a = api();
    render(<HireDetail hireId="h1" api={a} now={() => NOW} />);
    const input = (await screen.findByLabelText('Daily token cap')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
    await screen.findByText('A daily cap is a whole number of tokens above 0, or empty for off.');
    fireEvent.change(input, { target: { value: '250,000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
    await waitFor(() => expect(a.edits).toEqual([['cap', 'h1', 250_000]]));
  });

  test('saves repos one per line', async () => {
    const a = api();
    render(<HireDetail hireId="h1" api={a} now={() => NOW} />);
    const box = (await screen.findByLabelText('Repos')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'bodhi-fresh\n\nbodhi-care\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save repos' }));
    await waitFor(() => expect(a.edits).toEqual([['repos', 'h1', ['bodhi-fresh', 'bodhi-care']]]));
  });

  test('changes the account', async () => {
    const a = api();
    render(<HireDetail hireId="h1" api={a} now={() => NOW} />);
    const picker = (await screen.findByLabelText('Account')) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'Personal' });
    fireEvent.change(picker, { target: { value: 'acc-2' } });
    await waitFor(() => expect(a.edits).toEqual([['account', 'h1', 'acc-2']]));
  });

  test('an account that resolves to nothing here is shown as missing', async () => {
    render(<HireDetail hireId="h1" api={api({ getHire: async () => detail({ accountId: null, accountLabel: 'Gone' }) })} now={() => NOW} />);
    await screen.findByText(/Gone is not on this machine/);
  });

  test('let go asks first, and a refusal is shown', async () => {
    const a = api({ letGo: async () => ({ ok: false, error: "Let go isn't available on this machine yet." }) });
    render(<HireDetail hireId="h1" api={a} now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Let go…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Let go of Fresh PO' }));
    await screen.findByText("Let go isn't available on this machine yet.");
  });

  test('a hire held because its account signed out offers sign in again for that account', async () => {
    const a = api({ getHire: async () => detail({ activity: 'held', cause: 'signed-out' }) });
    render(<HireDetail hireId="h1" api={a} now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(a.edits).toEqual([['signIn', 'acc-1']]));
  });

  test('a refused sign in is shown', async () => {
    const a = api({
      getHire: async () => detail({ activity: 'held', cause: 'signed-out' }),
      signInAgain: async () => ({ ok: false, error: 'Sign-in was cancelled.' }),
    });
    render(<HireDetail hireId="h1" api={a} now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));
    await screen.findByText('Sign-in was cancelled.');
  });

  test('sign in again is offered only for a signed-out hold on an account this machine has', async () => {
    const cases: Partial<CrewHireDetail>[] = [
      { activity: 'idle', cause: null },
      { activity: 'held', cause: 'rate-limited' },
      { activity: 'held', cause: 'signed-out', accountId: null },
    ];
    for (const over of cases) {
      render(<HireDetail hireId="h1" api={api({ getHire: async () => detail(over) })} now={() => NOW} />);
      await screen.findByRole('heading', { name: 'Fresh PO' });
      expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
      cleanup();
    }
  });
});
