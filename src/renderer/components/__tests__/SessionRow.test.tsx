/**
 * SessionRow wiring tests (#141).
 *
 * Run with: bun test src/renderer/components/__tests__/SessionRow.test.tsx
 */
import React from 'react';
import { describe, expect, test, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SessionRow } from '../SessionRow';
import { ClaudeAccount, Session } from '../../../shared/types';

afterEach(cleanup);

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'login flow', groupId: 'g1', order: 0,
    state: 'running', shellType: 'claude', provider: 'claude',
    claudeAccountId: null,
    ...overrides,
  } as Session;
}

const noop = () => {};

function renderRow(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, number> = {
    select: 0, startEdit: 0, finishEdit: 0, cancelEdit: 0, close: 0, contextMenu: 0, dragStart: 0,
  };
  const props = {
    session: session(),
    isActive: false,
    isFocused: false,
    isDragging: false,
    dropPosition: null,
    draggable: true,
    account: null as ClaudeAccount | null,
    isEditing: false,
    editingName: '',
    onEditingNameChange: noop,
    onStartEdit: () => { calls.startEdit++; },
    onFinishEdit: () => { calls.finishEdit++; },
    onCancelEdit: () => { calls.cancelEdit++; },
    onSelect: () => { calls.select++; },
    onContextMenu: () => { calls.contextMenu++; },
    onDragStart: () => { calls.dragStart++; },
    onDragEnd: noop,
    onDragOver: noop,
    onDrop: noop,
    onClose: () => { calls.close++; },
    ...overrides,
  };
  const utils = render(<SessionRow {...(props as never)} />);
  return { calls, ...utils };
}

const row = () => document.querySelector('li.session') as HTMLLIElement;
const selectButton = () => document.querySelector('button.session-select') as HTMLButtonElement;

describe('SessionRow', () => {
  test('renders the session name and state', () => {
    renderRow();
    expect(screen.getByText('login flow')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
  });

  test('is a list item so it can live in the group list', () => {
    renderRow();
    expect(row().tagName).toBe('LI');
  });

  test('clicking the row selects the session', () => {
    const { calls } = renderRow();
    fireEvent.click(selectButton());
    expect(calls.select).toBe(1);
  });

  test('the close button closes without selecting', () => {
    const { calls } = renderRow();
    fireEvent.click(screen.getByLabelText('Close session'));
    expect(calls.close).toBe(1);
    expect(calls.select).toBe(0);
  });

  // The old markup scoped double-click to the name span only; the button now
  // spans the account dot, name, provider badge and status pill.
  test('double-click anywhere on the row starts a rename', () => {
    const { calls } = renderRow();
    fireEvent.doubleClick(screen.getByText('running')); // the status pill, not the name
    expect(calls.startEdit).toBe(1);
  });

  test('double-click on the name also starts a rename', () => {
    const { calls } = renderRow();
    fireEvent.doubleClick(screen.getByText('login flow'));
    expect(calls.startEdit).toBe(1);
  });

  test('editing swaps the row for an input and hides the select button', () => {
    renderRow({ isEditing: true, editingName: 'login flow' });
    expect(document.querySelector('input.session-name-input')).toBeTruthy();
    expect(selectButton()).toBeNull();
  });

  test('Enter commits a rename and Escape cancels it', () => {
    const { calls } = renderRow({ isEditing: true, editingName: 'new name' });
    const input = document.querySelector('input.session-name-input')!;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(calls.finishEdit).toBe(1);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(calls.cancelEdit).toBe(1);
  });

  test('the active row is marked with aria-current', () => {
    renderRow({ isActive: true });
    expect(selectButton().getAttribute('aria-current')).toBe('true');
    expect(row().className).toContain('active');
  });

  test('inactive rows omit aria-current entirely', () => {
    renderRow({ isActive: false });
    expect(selectButton().hasAttribute('aria-current')).toBe(false);
  });

  test('the row keeps a single tab stop — the close button', () => {
    renderRow();
    expect(selectButton().tabIndex).toBe(-1);
    const close = screen.getByLabelText('Close session') as HTMLButtonElement;
    expect(close.tabIndex).toBe(0);
  });

  test('drag is disabled when the caller says so', () => {
    renderRow({ draggable: false });
    expect(row().getAttribute('draggable')).toBe('false');
  });

  test('drag starts when enabled', () => {
    const { calls } = renderRow({ draggable: true });
    expect(row().getAttribute('draggable')).toBe('true');
    fireEvent.dragStart(row());
    expect(calls.dragStart).toBe(1);
  });

  test('right-click opens the context menu', () => {
    const { calls } = renderRow();
    fireEvent.contextMenu(row());
    expect(calls.contextMenu).toBe(1);
  });

  test('drop-target position becomes a class', () => {
    renderRow({ dropPosition: 'before' });
    expect(row().className).toContain('drop-before');
  });

  test('the account dot appears only when an account resolves', () => {
    renderRow();
    expect(document.querySelector('.session-account-dot')).toBeNull();

    cleanup();
    renderRow({ account: { id: 'a1', label: 'Work', email: null, color: '#61afef' } });
    const dot = document.querySelector('.session-account-dot') as HTMLElement;
    expect(dot).toBeTruthy();
    expect(dot.getAttribute('aria-label')).toBe('Account: Work');
  });

  test('an unapplied switch is marked on the row, not folded into the dot', () => {
    // Decline the "restart 5 sessions?" prompt after a group switch and the
    // sidebar is the only thing that speaks for the four sessions whose headers
    // are display:none. It used to recolour to the assignment immediately while
    // every pty went on billing the old login (#165).
    renderRow({
      account: { id: 'a1', label: 'Work', email: 'w@x.test', color: '#61afef' },
      pendingSwitch: { target: { id: 'a2', label: 'Personal', email: 'p@x.test', color: '#98c379' } },
    });

    const dot = document.querySelector('.session-account-dot') as HTMLElement;
    expect(dot.getAttribute('title')).toContain('Claude account: Work (w@x.test)');
    expect(dot.getAttribute('title')).toContain('assigned to Personal (p@x.test), restart to apply');
    expect(dot.getAttribute('aria-label')).toContain('restart to apply');
    expect(document.querySelector('.session-account-pending')).toBeTruthy();
  });

  test('a pending switch on a deleted account still names itself', () => {
    // Delete the account out from under a running session and the dot goes
    // with it — there is no account object left to colour or name. The marker
    // is then the only thing on the row that knows the pty is not where the
    // database says it is, so it stops being decorative and becomes an image
    // with a name of its own (#165).
    renderRow({
      account: null,
      pendingSwitch: { target: { id: 'a2', label: 'Personal', email: 'p@x.test', color: '#98c379' } },
    });

    expect(document.querySelector('.session-account-dot')).toBeNull();
    // By accessible name, not by presence: an unnamed span in the a11y tree is
    // exactly the failure this branch exists to prevent.
    const marker = screen.getByRole('img', {
      name: 'Account switch pending; restart to run under Personal (p@x.test)',
    });
    expect(marker.className).toContain('session-account-pending');
    expect(marker.hasAttribute('aria-hidden')).toBe(false);
  });

  test('a deleted account switching back to the default login says so', () => {
    // nameOf(null) is the default ~/.claude login, and "restart to run under
    // the default login" is the whole instruction — a bare "switch pending"
    // would not tell the user where a restart lands them.
    renderRow({ account: null, pendingSwitch: { target: null } });
    expect(screen.getByRole('img', {
      name: 'Account switch pending; restart to run under the default login',
    })).toBeTruthy();
  });

  test('the marker stays decorative while the dot is there to name the account', () => {
    // Two things saying "Work" into a screen reader is worse than one; the dot
    // already carries the pending wording in its own label.
    renderRow({
      account: { id: 'a1', label: 'Work', email: 'w@x.test', color: '#61afef' },
      pendingSwitch: { target: { id: 'a2', label: 'Personal', email: 'p@x.test', color: '#98c379' } },
    });
    const marker = document.querySelector('.session-account-pending') as HTMLElement;
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    expect(marker.hasAttribute('role')).toBe(false);
    expect(marker.hasAttribute('aria-label')).toBe(false);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  test('no pending marker when the pty is on the account it is assigned to', () => {
    renderRow({ account: { id: 'a1', label: 'Work', email: null, color: '#61afef' } });
    expect(document.querySelector('.session-account-pending')).toBeNull();
    expect(document.querySelector('.session-account-dot')!.getAttribute('title'))
      .not.toContain('restart to apply');
  });

  test('the provider badge shows only for non-default providers', () => {
    renderRow();
    expect(document.querySelector('.session-provider-badge')).toBeNull();

    cleanup();
    renderRow({ session: session({ provider: 'codex' }) });
    expect(document.querySelector('.session-provider-badge')).toBeTruthy();
  });
});

describe('a session whose working directory is not on this machine', () => {
  const parked = (overrides: Partial<Session> = {}) =>
    session({ state: 'stopped', workingDir: '/gone/here', workingDirMissing: true, ...overrides });

  test('offers a relink control naming the folder', () => {
    const relinks: number[] = [];
    renderRow({ session: parked(), onRelink: () => relinks.push(1) });

    const button = document.querySelector('button.session-relink') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.getAttribute('title')).toContain('/gone/here');

    fireEvent.click(button);
    expect(relinks).toHaveLength(1);
  });

  test('the control sits outside the select button, never nested in it', () => {
    renderRow({ session: parked(), onRelink: noop });

    const button = document.querySelector('button.session-relink')!;
    expect(button.closest('button.session-select')).toBeNull();
    expect(selectButton().querySelector('button')).toBeNull();
  });

  test('selecting the row is not triggered by the relink click', () => {
    const { calls } = renderRow({ session: parked(), onRelink: noop });

    fireEvent.click(document.querySelector('button.session-relink')!);
    expect(calls.select).toBe(0);
  });

  test('the row is marked so it reads as needing attention', () => {
    renderRow({ session: parked(), onRelink: noop });
    expect(row().className).toContain('needs-relink');
  });

  test('the state pill still reports the real state, never a derived one', () => {
    renderRow({ session: parked(), onRelink: noop });
    expect(document.querySelector('span.status-pill')!.textContent).toBe('stopped');
  });

  test('a session whose folder is present gets no relink control', () => {
    renderRow({ session: session({ state: 'stopped', workingDir: '/here' }), onRelink: noop });

    expect(document.querySelector('button.session-relink')).toBeNull();
    expect(row().className).not.toContain('needs-relink');
  });
});
