/**
 * The owner's "offer a share" flow (session sharing §7).
 *
 * Raised in review on #161: this is the primary entry point for minting a
 * share, so the branch that decides whether an invite is ADDRESSED or OPEN is
 * the one that most needs pinning — getting it backwards would turn a link
 * meant for one person into one anybody can use.
 *
 * Run with: bun test src/renderer/components/__tests__/ShareSessionModal.test.tsx
 */
import React from 'react';
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ShareSessionModal } from '../ShareSessionModal';

type CreateInput = {
  sessionId: string;
  expectedGithubLogin: string | null;
  role: string;
  grantTtlSeconds: number;
  inviteTtlSeconds: number;
};

let calls: CreateInput[] = [];
let nextResult: { code: string; url: string; expiresAt: number } | Error = {
  code: 'K7Q2-9F3D',
  url: 'https://relay.example.com/i/K7Q2-9F3D#fp=SHA256%3Aabc',
  expiresAt: Date.now() + 3_600_000,
};

beforeEach(() => {
  calls = [];
  nextResult = {
    code: 'K7Q2-9F3D',
    url: 'https://relay.example.com/i/K7Q2-9F3D#fp=SHA256%3Aabc',
    expiresAt: Date.now() + 3_600_000,
  };
  (globalThis as unknown as { window: Record<string, unknown> }).window ??= {};
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    relayCreateShare: (input: CreateInput) => {
      calls.push(input);
      return nextResult instanceof Error ? Promise.reject(nextResult) : Promise.resolve(nextResult);
    },
  };
});

afterEach(cleanup);

function renderModal(sessionId: string | null = 's1') {
  let closed = 0;
  render(<ShareSessionModal sessionId={sessionId} sessionName="Auth refactor" onClose={() => (closed += 1)} />);
  return { closes: () => closed };
}

const loginInput = () => screen.getByPlaceholderText('github-username') as HTMLInputElement;
const createBtn = () => screen.getByRole('button', { name: /create link/i });

describe('rendering', () => {
  test('renders nothing without a session', () => {
    renderModal(null);
    expect(document.querySelector('dialog')).toBeNull();
  });

  test('names the session being shared, so what is on offer is never ambiguous', () => {
    renderModal();
    expect(screen.getByText(/Auth refactor/)).toBeTruthy();
  });

  test('states both clocks separately', () => {
    // They mean different things — link lifetime vs access lifetime — and
    // collapsing them into one number would be a lie.
    renderModal();
    expect(screen.getByText(/The link works for/i)).toBeTruthy();
    expect(screen.getByText(/Once they join, access lasts/i)).toBeTruthy();
  });

  test('offers watch-and-type as disabled rather than hiding it', () => {
    // The absence of a control is not an explanation.
    renderModal();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios[1]!.disabled).toBe(true);
    expect(screen.getByText(/Not available yet/i)).toBeTruthy();
  });

  test('both role options carry accessible text', () => {
    // They were once nested too deeply for a11y tooling to find, which meant
    // the options had no accessible name at all on a consent screen.
    expect(screen.queryByText('Watch')).toBeNull();
    renderModal();
    expect(screen.getByText('Watch')).toBeTruthy();
    expect(screen.getByText('Watch and type')).toBeTruthy();
  });
});

describe('addressed vs open — the branch that matters', () => {
  test('cannot submit an addressed invite with no handle', () => {
    // Submitting blank would silently create an open link.
    renderModal();
    expect((createBtn() as HTMLButtonElement).disabled).toBe(true);
  });

  test('a typed handle is sent as the addressing', async () => {
    renderModal();
    fireEvent.change(loginInput(), { target: { value: '  Dana-K  ' } });
    fireEvent.click(createBtn());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.expectedGithubLogin).toBe('Dana-K');
    expect(calls[0]!.role).toBe('viewer');
  });

  test('the open-link toggle sends null, not an empty string', () => {
    // An empty string is not "no addressing" — it must be an explicit null or
    // the relay would try to match a handle nobody has.
    renderModal();
    fireEvent.change(loginInput(), { target: { value: 'dana-k' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect((createBtn() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(createBtn());
    return waitFor(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.expectedGithubLogin).toBeNull();
    });
  });

  test('the open-link toggle disables the handle field', () => {
    renderModal();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(loginInput().disabled).toBe(true);
  });

  test('only viewer is ever requested in this milestone', async () => {
    renderModal();
    fireEvent.change(loginInput(), { target: { value: 'dana-k' } });
    fireEvent.click(createBtn());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.role).toBe('viewer');
  });
});

describe('the created state', () => {
  async function create(open = false) {
    renderModal();
    if (open) fireEvent.click(screen.getByRole('checkbox'));
    else fireEvent.change(loginInput(), { target: { value: 'dana-k' } });
    fireEvent.click(createBtn());
    await waitFor(() => expect(screen.queryByText(/Send this link/i)).not.toBeNull());
  }

  test('shows the link and says it is the credential', async () => {
    // Anyone holding it who also satisfies the addressing can ask to join.
    await create();
    expect(screen.getByText(/This link is the key/i)).toBeTruthy();
    expect((screen.getByLabelText('Link') as HTMLInputElement).value).toContain('/i/K7Q2-9F3D');
  });

  test('shows the readable code for reading aloud', async () => {
    await create();
    expect(screen.getByText('K7Q2-9F3D')).toBeTruthy();
  });

  test('an addressed link says who it is for, and that approval is still needed', async () => {
    await create();
    expect(screen.getByText(/Only @dana-k can use this link/i)).toBeTruthy();
    expect(screen.getByText(/still have to let them in/i)).toBeTruthy();
  });

  test('an open link says anyone can ask, and that approval is still needed', async () => {
    await create(true);
    expect(screen.getByText(/Anyone with this link can ask/i)).toBeTruthy();
    expect(screen.getByText(/still have to let them in/i)).toBeTruthy();
  });
});

describe('failure', () => {
  test('surfaces the error and does not pretend a link was created', async () => {
    nextResult = new Error('relay rejected the share request (401)');
    renderModal();
    fireEvent.change(loginInput(), { target: { value: 'dana-k' } });
    fireEvent.click(createBtn());
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('401');
    expect(screen.queryByText(/Send this link/i)).toBeNull();
  });

  test('stays submittable after a failure so it can be retried', async () => {
    nextResult = new Error('nope');
    renderModal();
    fireEvent.change(loginInput(), { target: { value: 'dana-k' } });
    fireEvent.click(createBtn());
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    expect((createBtn() as HTMLButtonElement).disabled).toBe(false);
  });
});
