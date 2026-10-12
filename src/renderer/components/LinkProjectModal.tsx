import React, { useEffect, useRef, useState } from 'react';
import './NamePromptModal.css';
import './LinkProjectModal.css';

/**
 * Associate a group with a GitHub Projects v2 board (board-driven orchestration,
 * CO-722, Phase 2B). The user enters the project number (the `/projects/<n>`
 * segment of its URL); the caller resolves and stores the board's display name.
 * Clearing the number and confirming unlinks the group from any board.
 *
 * Built on the native <dialog> element so Escape, focus trapping and the
 * backdrop are handled by the platform (and accessibly), not hand-rolled onto
 * a <div>. Deliberately dumb: it only collects a number (or null) — resolving
 * the board title + persisting is the caller's job, so this stays free of IPC.
 */
interface LinkProjectModalProps {
  isOpen: boolean;
  groupName: string;
  initialNumber: number | null;
  onConfirm: (projectNumber: number | null) => void;
  onCancel: () => void;
}

export const LinkProjectModal: React.FC<LinkProjectModalProps> = ({
  isOpen,
  groupName,
  initialNumber,
  onConfirm,
  onCancel,
}) => {
  const [value, setValue] = useState(initialNumber != null ? String(initialNumber) : '');
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      setValue(initialNumber != null ? String(initialNumber) : '');
      setError(null);
      if (!dialog.open) dialog.showModal();
      setTimeout(() => inputRef.current?.select(), 50);
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isOpen, initialNumber]);

  // Close on a backdrop click. Attached as a ref listener rather than a JSX
  // onClick so it isn't read as a click handler on a "non-interactive" element
  // (Escape is the keyboard equivalent, handled natively via onCancel below).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onBackdropClick = (e: MouseEvent) => { if (e.target === dialog) onCancel(); };
    dialog.addEventListener('click', onBackdropClick);
    return () => dialog.removeEventListener('click', onBackdropClick);
  }, [onCancel]);

  const handleSubmit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '') {
      onConfirm(null); // Empty = unlink.
      return;
    }
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== trimmed) {
      setError('Enter a positive whole number (the /projects/<n> segment of the board URL).');
      return;
    }
    onConfirm(n);
  };

  return (
    <dialog
      ref={dialogRef}
      className="name-prompt-modal link-project-dialog"
      aria-labelledby="link-project-title"
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
    >
      <h3 id="link-project-title">Link GitHub Project — {groupName}</h3>
      <form onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={value}
          onChange={e => { setValue(e.target.value); setError(null); }}
          placeholder="Project number, e.g. 17"
        />
        <span className="provider-picker-hint">
          {error ?? 'Leave empty and confirm to unlink this group from any board.'}
        </span>
        <div className="modal-buttons">
          <button type="button" className="cancel-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="confirm-btn">
            {value.trim() === '' ? 'Unlink' : 'Link'}
          </button>
        </div>
      </form>
    </dialog>
  );
};
