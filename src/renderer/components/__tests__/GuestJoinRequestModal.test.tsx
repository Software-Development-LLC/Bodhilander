/**
 * The consent step for letting a guest watch (session sharing §7).
 *
 * The tests that matter are about what the owner is shown and how easy the
 * refusing answer is — this is the moment trust is handed over, and the
 * failure mode is someone approving a request they misread.
 *
 * Run with: bun test src/renderer/components/__tests__/GuestJoinRequestModal.test.tsx
 */
import React from 'react';
import { describe, expect, test, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { GuestJoinRequestModal } from '../GuestJoinRequestModal';
import type { RelayPendingShare } from '../../../shared/types';

afterEach(cleanup);

const request = (over: Partial<RelayPendingShare> = {}): RelayPendingShare => ({
  grantId: 'grant-1',
  role: 'viewer',
  granteeLogin: 'dana-k',
  granteeName: 'Dana K',
  createdAt: Date.now(),
  sessionId: 's1',
  sessionName: 'Auth refactor',
  ...over,
});

function renderModal(over: { request?: RelayPendingShare | null } = {}) {
  const approved: string[] = [];
  const denied: string[] = [];
  render(
    <GuestJoinRequestModal
      request={over.request === undefined ? request() : over.request}
      onApprove={(id) => approved.push(id)}
      onDeny={(id) => denied.push(id)}
    />,
  );
  return { approved, denied };
}

const dialogEl = () => document.querySelector('dialog')!;

describe('what the owner is shown', () => {
  test('renders nothing when there is no request', () => {
    renderModal({ request: null });
    expect(document.querySelector('dialog')).toBeNull();
  });

  test('leads with the immutable GitHub handle', () => {
    // A display name is free text the account holder picks; showing it as the
    // identity would let someone set it to a name the owner trusts.
    renderModal();
    expect(screen.getByText('@dana-k')).toBeTruthy();
  });

  test('names the session being asked for', () => {
    renderModal();
    expect(screen.getByText(/Auth refactor/)).toBeTruthy();
  });

  test('says plainly what the guest will and will not be able to do', () => {
    renderModal();
    expect(screen.getByText(/can't type/i)).toBeTruthy();
    expect(screen.getByText(/not what came before/i)).toBeTruthy();
  });

  test('an account with no handle on record says so rather than substituting a name', () => {
    // Falling back to a display name here would present something that proves
    // nothing as though it were the identity.
    renderModal({ request: request({ granteeLogin: null, granteeName: 'Totally Will' }) });
    expect(screen.getByText(/no GitHub handle on record/i)).toBeTruthy();
    expect(screen.queryByText('Totally Will')).toBeNull();
  });
});

describe('answering', () => {
  test('approving reports the grant id', () => {
    const h = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /let them watch/i }));
    expect(h.approved).toEqual(['grant-1']);
  });

  test('declining reports the grant id', () => {
    const h = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /don't let them in/i }));
    expect(h.denied).toEqual(['grant-1']);
  });

  test('nothing is approved merely by rendering', () => {
    const h = renderModal();
    expect(h.approved).toEqual([]);
    expect(h.denied).toEqual([]);
  });

  test('Escape declines rather than dismissing', () => {
    // Dismissing would leave the guest waiting on an answer nobody can see.
    const h = renderModal();
    fireEvent(dialogEl(), new Event('cancel', { bubbles: false, cancelable: true }));
    expect(h.denied).toEqual(['grant-1']);
    expect(h.approved).toEqual([]);
  });

  test('there are exactly two ways out, and neither is a snooze', () => {
    // Not "Not now" — that reads as deferral, and declining is not one.
    renderModal();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /not now|later|remind/i })).toBeNull();
  });
});

describe('a request this machine can no longer honour', () => {
  test('approving is disabled when the session is unknown', () => {
    // The invite's session mapping lives only on this desktop. Without it,
    // approving would not know what to share.
    renderModal({ request: request({ sessionName: null, sessionId: null }) });
    expect(screen.getByRole('button', { name: /let them watch/i }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/no longer has a record/i)).toBeTruthy();
  });

  test('declining still works in that state', () => {
    const h = renderModal({ request: request({ sessionName: null, sessionId: null }) });
    fireEvent.click(screen.getByRole('button', { name: /don't let them in/i }));
    expect(h.denied).toEqual(['grant-1']);
  });
});
