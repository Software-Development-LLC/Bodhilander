import React, { useCallback, useEffect, useRef } from 'react';
import type { RelayStatus } from '../../shared/types';
import './NamePromptModal.css';
import './OwnerConfirmModal.css';

/**
 * "Is this you?" — the one-time confirmation that binds this machine to a
 * relay account (docs/designs/session-sharing.md §3).
 *
 * The desktop cannot learn its own relay user id from anywhere trustworthy:
 * `agent:ready` carries only a machine id, so the account shown here is
 * something the *relay* asserted. Accepting it automatically would let whoever
 * runs the relay name themselves the owner of someone's machine and inherit
 * every capability that follows. A person answers instead, once.
 *
 * The dismissive action is focused and the accepting one is not, because the
 * safe answer to an unexpected prompt is "no". There is no close affordance
 * for the same reason — dismissing this by accident would leave the machine
 * connected with the question unanswered.
 */

export type PendingOwner = NonNullable<RelayStatus['pendingOwner']>;

interface OwnerConfirmModalProps {
  pending: PendingOwner | null;
  onConfirm: (userId: string) => void;
  onReject: () => void;
}

export const OwnerConfirmModal: React.FC<OwnerConfirmModalProps> = ({ pending, onConfirm, onReject }) => {
  const rejectRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (pending) setTimeout(() => rejectRef.current?.focus(), 50);
  }, [pending]);

  const handleModalKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Escape is the safe answer, and it is the same as saying no — not a
      // dismissal that would leave the machine reachable with this unresolved.
      if (e.key === 'Escape') {
        onReject();
        return;
      }
      if (e.key === 'Tab') {
        const modal = e.currentTarget as HTMLElement;
        const focusable = modal.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onReject],
  );

  if (!pending) return null;

  const name = pending.displayName?.trim() || pending.userId;

  return (
    // No onClick on the overlay: this is not dismissible by clicking away.
    <div className="modal-overlay">
      <div
        className="name-prompt-modal owner-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="owner-confirm-title"
        aria-describedby="owner-confirm-body"
        onKeyDown={handleModalKeyDown}
      >
        <h3 id="owner-confirm-title">{pending.isChange ? 'This machine changed hands' : 'Is this you?'}</h3>

        <div id="owner-confirm-body">
          <p className="owner-confirm-lede">
            {pending.isChange
              ? 'This machine is now linked to a different account:'
              : 'This machine is now linked to:'}
          </p>

          <div className="owner-confirm-identity">
            <span className="owner-confirm-name">{name}</span>
            {pending.email && <span className="owner-confirm-email">{pending.email}</span>}
          </div>

          <p className="owner-confirm-note">
            Confirming lets this account reach your terminals from a browser, and lets you share
            individual sessions with other people. If you don&apos;t recognise it, say no — someone
            else may have claimed this machine&apos;s link code.
          </p>

          {pending.isChange && (
            <p className="owner-confirm-warning">
              Any sessions you shared under the previous account will stop working.
            </p>
          )}
        </div>

        <div className="modal-buttons">
          {/* Focused: the safe answer to an unexpected prompt is no. */}
          <button ref={rejectRef} type="button" className="cancel-btn" onClick={onReject}>
            No, that&apos;s not me
          </button>
          <button type="button" className="confirm-btn" onClick={() => onConfirm(pending.userId)}>
            Yes, that&apos;s me
          </button>
        </div>
      </div>
    </div>
  );
};
