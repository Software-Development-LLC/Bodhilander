import React, { useCallback, useEffect, useRef } from 'react';
import type { RelayPendingShare } from '../../shared/types';
import './ShareSessionModal.css';
import './GuestJoinRequestModal.css';

/**
 * "Let them in?" — the consent step (docs/designs/session-sharing.md §7).
 *
 * Shows the **immutable GitHub login**, not a display name or an avatar. A
 * display name is free text the account holder chooses, so showing it here
 * would let someone set it to a name the owner trusts and borrow that trust at
 * exactly the moment it matters. The handle cannot be chosen that way.
 *
 * The refusing button is focused and the buttons say what they do. Not
 * "Not now" — that reads as a snooze, and this is not one: declining ends the
 * request, and the person has to be invited again.
 */

interface GuestJoinRequestModalProps {
  request: RelayPendingShare | null;
  onApprove: (grantId: string) => void;
  onDeny: (grantId: string) => void;
}

export const GuestJoinRequestModal: React.FC<GuestJoinRequestModalProps> = ({ request, onApprove, onDeny }) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !request) return;
    if (!dialog.open) dialog.showModal();
    denyRef.current?.focus();
  }, [request]);

  const handleCancel = useCallback(
    (e: React.SyntheticEvent<HTMLDialogElement>) => {
      // Escape declines rather than dismissing. Leaving the request open with
      // the prompt gone would mean the guest waits on an answer nobody can see.
      e.preventDefault();
      if (request) onDeny(request.grantId);
    },
    [request, onDeny],
  );

  if (!request) return null;

  const who = request.granteeLogin ? `@${request.granteeLogin}` : null;

  return (
    <dialog
      ref={dialogRef}
      className="share-session-modal guest-join-modal"
      aria-labelledby="guest-join-title"
      aria-describedby="guest-join-body"
      onCancel={handleCancel}
    >
      <h3 id="guest-join-title">Let them watch?</h3>

      <div id="guest-join-body">
        <div className="guest-join-identity">
          {who ? (
            <span className="guest-join-login">{who}</span>
          ) : (
            // No handle means the account predates login capture. Say that,
            // rather than falling back to a name that proves nothing.
            <span className="guest-join-unknown">an account with no GitHub handle on record</span>
          )}
          {request.granteeName && who && <span className="guest-join-name">{request.granteeName}</span>}
        </div>

        <p className="guest-join-what">
          wants to watch{' '}
          <strong>{request.sessionName ? `“${request.sessionName}”` : 'a session you shared'}</strong>.
        </p>

        <p className="guest-join-note">
          They&apos;ll see this session&apos;s live output from the moment you let them in — not what came
          before. They can&apos;t type, create sessions, or browse your files. You can end it at any time.
        </p>

        {!request.sessionName && (
          <p className="guest-join-warning">
            This machine no longer has a record of which session the invite was for. Letting them in now
            would not know what to share — decline and send a fresh link.
          </p>
        )}
      </div>

      <div className="share-buttons">
        {/* Focused: the safe answer to an unexpected request is no. */}
        <button ref={denyRef} type="button" className="share-secondary" onClick={() => onDeny(request.grantId)}>
          Don&apos;t let them in
        </button>
        <button
          type="button"
          className="share-primary"
          disabled={!request.sessionName}
          onClick={() => onApprove(request.grantId)}
        >
          Let them watch
        </button>
      </div>
    </dialog>
  );
};
