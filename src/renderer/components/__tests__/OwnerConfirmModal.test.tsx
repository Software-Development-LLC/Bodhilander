/**
 * OwnerConfirmModal behaviour (session sharing §3).
 *
 * The account shown here is asserted by the relay, and confirming it grants
 * owner capability on this machine — so the tests that matter are the ones
 * about *not* accepting: nothing auto-confirms, the safe answer is focused,
 * and there is no way to dismiss the question without answering it.
 *
 * Run with: bun test src/renderer/components/__tests__/OwnerConfirmModal.test.tsx
 */
import React from 'react';
import { describe, expect, test, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { OwnerConfirmModal, type PendingOwner } from '../OwnerConfirmModal';

afterEach(cleanup);

const pending = (over: Partial<PendingOwner> = {}): PendingOwner => ({
  userId: 'user-123',
  displayName: 'dana-k',
  email: 'dana@example.com',
  isChange: false,
  ...over,
});

function renderModal(over: { pending?: PendingOwner | null } = {}) {
  const confirmed: string[] = [];
  let rejected = 0;
  render(
    <OwnerConfirmModal
      pending={over.pending === undefined ? pending() : over.pending}
      onConfirm={(id) => confirmed.push(id)}
      onReject={() => {
        rejected += 1;
      }}
    />,
  );
  return { confirmed, rejects: () => rejected };
}

describe('rendering', () => {
  test('renders nothing when there is nothing to confirm', () => {
    renderModal({ pending: null });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('shows the asserted account so the human can recognise it', () => {
    renderModal();
    expect(screen.getByText('dana-k')).toBeTruthy();
    expect(screen.getByText('dana@example.com')).toBeTruthy();
  });

  test('falls back to the raw user id when there is no display name', () => {
    // Better to show an opaque id than to render an empty box that looks like
    // a legitimately blank name.
    renderModal({ pending: pending({ displayName: null }) });
    expect(screen.getByText('user-123')).toBeTruthy();
  });

  test('an owner change is framed as a change, and warns about existing shares', () => {
    renderModal({ pending: pending({ isChange: true }) });
    expect(screen.getByText(/changed hands/i)).toBeTruthy();
    expect(screen.getByText(/stop working/i)).toBeTruthy();
  });

  test('a first-time confirmation does not show the change warning', () => {
    renderModal();
    expect(screen.queryByText(/stop working/i)).toBeNull();
  });
});

describe('answering', () => {
  test('confirming reports the exact user id that was displayed', () => {
    // Not a boolean: the id must round-trip, so a status push that swapped the
    // pending owner mid-decision cannot be confirmed as the one on screen.
    const h = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /yes, that's me/i }));
    expect(h.confirmed).toEqual(['user-123']);
  });

  test('rejecting reports a rejection', () => {
    const h = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /not me/i }));
    expect(h.rejects()).toBe(1);
  });

  test('nothing is confirmed merely by rendering', () => {
    const h = renderModal();
    expect(h.confirmed).toEqual([]);
    expect(h.rejects()).toBe(0);
  });
});

describe('the safe answer is the easy one', () => {
  test('Escape rejects rather than dismissing', () => {
    // Dismissing without answering would leave the machine connected with the
    // question open, which is the state this modal exists to prevent.
    const h = renderModal();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(h.rejects()).toBe(1);
    expect(h.confirmed).toEqual([]);
  });

  test('clicking the overlay does not dismiss it', () => {
    const h = renderModal();
    const overlay = screen.getByRole('dialog').parentElement!;
    fireEvent.click(overlay);
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(h.rejects()).toBe(0);
  });

  test('there is no close affordance other than the two answers', () => {
    renderModal();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  test('the dialog is labelled and modal for assistive tech', () => {
    renderModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('owner-confirm-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('owner-confirm-body');
  });
});
