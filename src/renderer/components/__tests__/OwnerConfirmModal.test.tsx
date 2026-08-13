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
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { OwnerConfirmModal, type PendingOwner } from '../OwnerConfirmModal';

/**
 * Which opener the component used. happy-dom implements both `show()` and
 * `showModal()`, and only the latter makes the page inert and traps focus — so
 * this records the choice rather than trusting that `open` became true.
 */
let modalCalls: string[] = [];
const nativeShowModal = HTMLDialogElement.prototype.showModal;
const nativeShow = HTMLDialogElement.prototype.show;

beforeEach(() => {
  modalCalls = [];
  HTMLDialogElement.prototype.showModal = function patchedShowModal(this: HTMLDialogElement) {
    modalCalls.push('showModal');
    return nativeShowModal.call(this);
  };
  HTMLDialogElement.prototype.show = function patchedShow(this: HTMLDialogElement) {
    modalCalls.push('show');
    return nativeShow.call(this);
  };
});

afterEach(() => {
  HTMLDialogElement.prototype.showModal = nativeShowModal;
  HTMLDialogElement.prototype.show = nativeShow;
  cleanup();
});

/** The rendered dialog element. */
const dialogEl = (): HTMLDialogElement => document.querySelector('dialog')!;

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
    // Native <dialog> would close on Escape and leave the question open with
    // the machine still reachable, which is the state this modal exists to
    // prevent. The cancel event is routed to rejection instead.
    const h = renderModal();
    fireEvent(dialogEl(), new Event('cancel', { bubbles: false, cancelable: true }));
    expect(h.rejects()).toBe(1);
    expect(h.confirmed).toEqual([]);
  });

  test('clicking outside does not dismiss it', () => {
    // showModal() makes the rest of the page inert and the backdrop
    // non-dismissing; this pins that we did not reintroduce a click-away.
    const h = renderModal();
    fireEvent.click(document.body);
    expect(dialogEl().open).toBe(true);
    expect(h.rejects()).toBe(0);
  });

  test('there is no close affordance other than the two answers', () => {
    renderModal();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  test('it opens as a modal, not an inline dialog', () => {
    // showModal() rather than show(): the latter renders in place, leaves the
    // page interactive, and traps nothing.
    renderModal();
    expect(dialogEl().open).toBe(true);
    expect(modalCalls).toEqual(['showModal']);
  });

  test('the dialog is labelled and described for assistive tech', () => {
    renderModal();
    const dialog = dialogEl();
    expect(dialog.getAttribute('aria-labelledby')).toBe('owner-confirm-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('owner-confirm-body');
  });
});
