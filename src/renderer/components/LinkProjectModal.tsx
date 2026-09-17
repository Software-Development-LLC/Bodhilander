import React, { useEffect, useRef, useState } from 'react';
import './NamePromptModal.css';

/**
 * Associate a group with a GitHub Projects v2 board (board-driven orchestration,
 * CO-722, Phase 2B). The user enters the project number (the `/projects/<n>`
 * segment of its URL); the caller resolves and stores the board's display name.
 * Clearing the number and confirming unlinks the group from any board.
 *
 * Deliberately dumb: it only collects a number (or null). Resolving the board
 * title + persisting is the caller's job, so this stays free of IPC.
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValue(initialNumber != null ? String(initialNumber) : '');
      setError(null);
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 50);
    }
  }, [isOpen, initialNumber]);

  const handleSubmit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '') {
      // Empty = unlink.
      onConfirm(null);
      return;
    }
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== trimmed) {
      setError('Enter a positive whole number (the /projects/<n> segment of the board URL).');
      return;
    }
    onConfirm(n);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="name-prompt-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-project-title"
        onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
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
            autoFocus
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
      </div>
    </div>
  );
};
