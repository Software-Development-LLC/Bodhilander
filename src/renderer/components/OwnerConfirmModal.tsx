import React, { useCallback, useEffect, useRef } from 'react';
import type { RelayStatus } from '../../shared/types';
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
 * Built on native `<dialog>` + `showModal()` rather than a div with an overlay.
 * That gives real modality — the browser makes the rest of the page inert and
 * traps focus itself — instead of a hand-rolled Tab cycle that only looks like
 * it does. Clicking the backdrop does not dismiss a modal dialog, which is the
 * behaviour this prompt wants: it must be answered.
 *
 * The dismissive action holds focus and the accepting one does not, because
 * the safe answer to an unexpected prompt is "no". `cancel` (Escape) is routed
 * to rejection rather than allowed to close the dialog, so there is no way out
 * that leaves the machine connected with the question unanswered.
 */

export type PendingOwner = NonNullable<RelayStatus['pendingOwner']>;

interface OwnerConfirmModalProps {
  pending: PendingOwner | null;
  onConfirm: (userId: string) => void;
  onReject: () => void;
}

export const OwnerConfirmModal: React.FC<OwnerConfirmModalProps> = ({ pending, onConfirm, onReject }) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending) {
      // showModal() throws InvalidStateError on an already-open dialog.
      if (!dialog.open) dialog.showModal();
      rejectRef.current?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [pending]);

  const handleCancel = useCallback(
    (e: React.SyntheticEvent<HTMLDialogElement>) => {
      // Escape would otherwise close the dialog and leave the question open
      // with the machine still reachable. Treat it as the safe answer instead.
      e.preventDefault();
      onReject();
    },
    [onReject],
  );

  if (!pending) return null;

  // The emptiness test is explicit rather than a `||` or a `x ? x : y`,
  // because the fallback has to cover BOTH a missing display name and one that
  // trims to nothing — `??` alone would let a whitespace-only name through and
  // render a blank box that reads as a legitimately empty name.
  const trimmedName = pending.displayName?.trim() ?? '';
  const name = trimmedName.length > 0 ? trimmedName : pending.userId;

  return (
    <dialog
      ref={dialogRef}
      className="owner-confirm-modal"
      aria-labelledby="owner-confirm-title"
      aria-describedby="owner-confirm-body"
      onCancel={handleCancel}
    >
      <h3 id="owner-confirm-title">{pending.isChange ? 'This machine changed hands' : 'Is this you?'}</h3>

      <div id="owner-confirm-body">
        <p className="owner-confirm-lede">
          {pending.isChange ? 'This machine is now linked to a different account:' : 'This machine is now linked to:'}
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

      <div className="owner-confirm-buttons">
        {/* Focused: the safe answer to an unexpected prompt is no. */}
        <button ref={rejectRef} type="button" className="owner-confirm-reject" onClick={onReject}>
          No, that&apos;s not me
        </button>
        <button type="button" className="owner-confirm-accept" onClick={() => onConfirm(pending.userId)}>
          Yes, that&apos;s me
        </button>
      </div>
    </dialog>
  );
};
