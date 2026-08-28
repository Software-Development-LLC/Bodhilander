/**
 * The arrival report as the window shows it.
 *
 * The report exists to say what a restore did NOT finish, so the tests that
 * matter are about what it declines to claim: an account whose login evidence
 * was unreadable is not listed as needing a sign-in, and closing it is not the
 * same as saying the work is done.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { ArrivalReport } from '../../../shared/types';

/**
 * The login modal embeds a live xterm `<Terminal>`, which has no business
 * being stood up here. Stubbed down to the two things this file is about: that
 * it is rendered at all, and that it is given the pty id the sign-in returned.
 */
const realAccountsModal = await import('../ClaudeAccountsModal');
mock.module('../ClaudeAccountsModal', () => ({
  ...realAccountsModal,
  ClaudeAccountLoginModal: ({ account, ptyId, onCancel }: {
    account: { id: string };
    ptyId: string;
    onCancel: (deleteAccount: boolean) => void;
  }) => (
    <div data-testid="login-modal" data-account={account.id} data-pty={ptyId}>
      <button onClick={() => onCancel(false)}>Stop Login</button>
    </div>
  ),
}));

// Hand the real module back: in a shared-registry run a stub left registered
// here would silently become another spec's subject.
afterAll(() => {
  mock.module('../ClaudeAccountsModal', () => realAccountsModal);
});

const { ArrivalReportModal, ArrivalReportView } = await import('../ArrivalReport');

const REPORT: ArrivalReport = {
  restoredAt: '2026-08-28T10:00:00.000Z',
  via: 'handoff',
  sourceLabel: 'Old Laptop',
  sourcePlatform: 'darwin',
  groups: 3,
  sessions: 10,
  resumable: 8,
  transcripts: 42,
  skippedGroups: 0,
  skippedSessions: 0,
  needsRelink: [
    { sessionId: 's1', name: 'api', workingDir: '/Users/will/Work/api' },
    { sessionId: 's2', name: 'web', workingDir: '/Users/will/Work/web' },
  ],
  accounts: [
    { accountId: 'a1', label: 'work', loggedIn: false },
    { accountId: 'a2', label: 'personal', loggedIn: true },
    { accountId: 'a3', label: 'unreadable', loggedIn: undefined },
  ],
  providersNeedingKeys: ['openai'],
};

let dismissed: number;
let resumed: string[];
let cancelled: { ptyId: string; deleteAccount: boolean }[];
let relinked: { sessionId: string; workingDir: string }[];
/** What the folder picker answers next; null is the user cancelling it. */
let pickedDir: string | null;

beforeEach(() => {
  dismissed = 0;
  resumed = [];
  cancelled = [];
  relinked = [];
  pickedDir = '/home/will/Work/api';
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    arrivalDismiss: async () => {
      dismissed++;
    },
    resumeAccountLogin: async (accountId: string) => {
      resumed.push(accountId);
      return { account: { id: accountId }, ptyId: `__login-${accountId}` };
    },
    cancelAccountLogin: async (ptyId: string, deleteAccount: boolean) => {
      cancelled.push({ ptyId, deleteAccount });
    },
    selectDirectory: async () => pickedDir,
    arrivalResolveRelink: async (sessionId: string, workingDir: string) => {
      relinked.push({ sessionId, workingDir });
      // What main returns: the kept report, rewritten.
      const needsRelink = REPORT.needsRelink.filter(
        (r) => !relinked.some((done) => done.sessionId === r.sessionId),
      );
      return { ...REPORT, needsRelink, resumable: REPORT.sessions - needsRelink.length };
    },
  };
});

afterEach(cleanup);

function view(report: ArrivalReport = REPORT, onClose = () => {}, onDismiss = () => {}) {
  render(
    <ArrivalReportView
      report={report}
      onClose={onClose}
      onDismiss={onDismiss}
      onSignIn={() => {}}
      onRelink={() => {}}
    />,
  );
}

async function click(label: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: label }));
  });
}

/** There is one per unlinked session, so they are addressed by position. */
async function clickRelink(index = 0) {
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Set Folder…' })[index]);
  });
}

describe('what it says', () => {
  test('names the machine it came from and what can actually start', () => {
    view();
    const dialog = screen.getByRole('dialog');

    expect(dialog.textContent).toContain('Old Laptop');
    expect(dialog.textContent).toContain('8');
    expect(dialog.textContent).toContain('2 sessions need their folder');
  });

  test('lists each session that cannot start, with the folder it looked for', () => {
    view();
    const section = screen.getByRole('region', { name: 'Sessions needing a folder' });

    expect(section.textContent).toContain('api');
    expect(section.textContent).toContain('/Users/will/Work/api');
    expect(section.textContent).toContain('web');
  });

  test('lists only the accounts with no credentials here', () => {
    view();
    const section = screen.getByRole('region', { name: 'Accounts needing a sign-in' });

    expect(section.textContent).toContain('work');
    // Signed in — nothing to do.
    expect(section.textContent).not.toContain('personal');
    // Unreadable is not logged out. Sending someone to re-authenticate on that
    // basis is worse than saying nothing, and the file is rewritten about once
    // a minute so a torn read is ordinary.
    expect(section.textContent).not.toContain('unreadable');
  });

  test('names the provider keys that were deliberately not carried', () => {
    view();
    const section = screen.getByRole('region', { name: 'Provider keys to re-enter' });

    expect(section.textContent).toContain('openai');
  });

  test('a restore with nothing outstanding shows no job lists at all', () => {
    view({ ...REPORT, needsRelink: [], accounts: [{ accountId: 'a2', label: 'p', loggedIn: true }], providersNeedingKeys: [] });

    expect(screen.queryByRole('region', { name: 'Sessions needing a folder' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Accounts needing a sign-in' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Provider keys to re-enter' })).toBeNull();
    // The counts still stand: this is a report, not only a to-do list.
    expect(screen.getByRole('region', { name: 'What was restored' }).textContent).toContain('10');
  });

  test('a timestamp that is not one is left out rather than rendered as Invalid Date', () => {
    view({ ...REPORT, restoredAt: 'not a date' });

    expect(screen.getByRole('dialog').textContent).not.toContain('Invalid Date');
  });

  test('falls back to naming the transport when no machine name came with it', () => {
    view({ ...REPORT, sourceLabel: null, via: 'file' });

    expect(screen.getByRole('dialog').textContent).toContain('a transfer bundle');
  });
});

describe('closing it', () => {
  test('opens modal, so the report is read rather than sitting behind the window', () => {
    view();

    expect((screen.getByRole('dialog') as HTMLDialogElement).open).toBe(true);
  });

  test('Close keeps it — the work it lists is rarely done yet', async () => {
    let closed = 0;
    view(REPORT, () => closed++);

    await click('Close');

    expect(closed).toBe(1);
    expect(dismissed).toBe(0);
  });

  test('Escape closes without dismissing, the same as Close', async () => {
    let closed = 0;
    let gone = 0;
    view(REPORT, () => closed++, () => gone++);
    const cancel = new Event('cancel', { cancelable: true, bubbles: false });

    await act(async () => {
      fireEvent(screen.getByRole('dialog'), cancel);
    });

    // `defaultPrevented`, not `open`: happy-dom does not close a dialog on
    // `cancel` by itself, so asserting it stayed open would pass with no
    // handler at all.
    expect(cancel.defaultPrevented).toBe(true);
    expect(closed).toBe(1);
    expect(gone).toBe(0);
  });

  test('only the explicit button forgets it', async () => {
    let closed = 0;
    render(<ArrivalReportModal report={REPORT} onClosed={() => closed++} />);

    await click(/Don.t Show Again/);

    expect(dismissed).toBe(1);
    expect(closed).toBe(1);
  });
});

describe('relinking a session from the report', () => {
  test('sends the chosen folder for the session on that row', async () => {
    render(<ArrivalReportModal report={REPORT} onClosed={() => {}} />);

    await clickRelink();

    expect(relinked).toEqual([{ sessionId: 's1', workingDir: '/home/will/Work/api' }]);
  });

  test('drops the row, and follows the count in the heading', async () => {
    render(<ArrivalReportModal report={REPORT} onClosed={() => {}} />);
    expect(screen.getByRole('region', { name: 'Sessions needing a folder' }).textContent)
      .toContain('2 sessions need their folder');

    await clickRelink();

    const section = screen.getByRole('region', { name: 'Sessions needing a folder' });
    // Redrawn from what main stored, not from a local guess at it.
    expect(section.textContent).toContain('1 session needs its folder');
    expect(section.textContent).not.toContain('api');
    expect(section.textContent).toContain('web');
  });

  test('the section goes when the last one is resolved, and the report stays up', async () => {
    render(<ArrivalReportModal report={REPORT} onClosed={() => {}} />);

    await clickRelink();
    pickedDir = '/home/will/Work/web';
    await clickRelink();

    expect(screen.queryByRole('region', { name: 'Sessions needing a folder' })).toBeNull();
    // Deliberately still open: the counts are worth reading, and a dialog that
    // vanishes as you finish with it reads as a crash. It stops being *raised*
    // on the next launch instead, which is the launch check's job.
    expect((screen.getByRole('dialog') as HTMLDialogElement).open).toBe(true);
  });

  test('says so when the relink fails, instead of a button that did nothing', async () => {
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.arrivalResolveRelink =
      async () => {
        throw new Error('EACCES: that folder is not readable');
      };
    render(<ArrivalReportModal report={REPORT} onClosed={() => {}} />);

    await clickRelink();

    // Uncaught, this was an unhandled rejection with the button quietly
    // re-enabling and the row still sitting there — which reads as the button
    // not working rather than as the folder being unusable.
    expect(screen.getByRole('alert').textContent).toContain('EACCES');
    expect(screen.getByRole('region', { name: 'Sessions needing a folder' }).textContent)
      .toContain('2 sessions need their folder');
  });

  test('clears a previous failure when the next attempt is made', async () => {
    let fail = true;
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.arrivalResolveRelink =
      async (sessionId: string, workingDir: string) => {
        if (fail) throw new Error('EACCES');
        relinked.push({ sessionId, workingDir });
        return { ...REPORT, needsRelink: REPORT.needsRelink.slice(1), resumable: 9 };
      };
    render(<ArrivalReportModal report={REPORT} onClosed={() => {}} />);
    await clickRelink();
    expect(screen.queryByRole('alert')).not.toBeNull();

    fail = false;
    await clickRelink();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('cancelling the picker changes nothing at all', async () => {
    pickedDir = null;
    render(<ArrivalReportModal report={REPORT} onClosed={() => {}} />);

    await clickRelink();

    expect(relinked).toEqual([]);
    expect(screen.getByRole('region', { name: 'Sessions needing a folder' }).textContent)
      .toContain('2 sessions need their folder');
  });
});

describe('signing in from the report', () => {
  test('runs the flow for the account named on the row', async () => {
    render(<ArrivalReportModal report={REPORT} onClosed={() => {}} />);

    await click('Sign In');

    // The restored account's own id, not a fresh one: the row travelled with
    // its label, colour and place in the failover order, and only its
    // credentials were missing.
    expect(resumed).toEqual(['a1']);
  });

  test('raises the login terminal, so the flow has somewhere to happen', async () => {
    render(<ArrivalReportModal report={REPORT} onClosed={() => {}} />);

    await click('Sign In');

    // `resumeAccountLogin` spawns a live pty and returns its id. Discarding
    // that id leaves the pty running with no terminal attached and no way for
    // the user to finish the OAuth flow — the button would look inert.
    const modal = screen.getByTestId('login-modal');
    expect(modal.getAttribute('data-account')).toBe('a1');
    expect(modal.getAttribute('data-pty')).toBe('__login-a1');
  });

  test('abandoning the sign-in stops the pty and never deletes the account', async () => {
    render(<ArrivalReportModal report={REPORT} onClosed={() => {}} />);
    await click('Sign In');

    await click('Stop Login');

    // An interrupted sign-in is not an aborted one. This account is the
    // user's, brought back by a restore, and losing it here would be far worse
    // than leaving it signed out.
    expect(cancelled).toEqual([{ ptyId: '__login-a1', deleteAccount: false }]);
    expect(screen.queryByTestId('login-modal')).toBeNull();
  });

  test('renders nothing at all when there is no report', () => {
    render(<ArrivalReportModal report={null} onClosed={() => {}} />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
