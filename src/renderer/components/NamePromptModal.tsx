import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ClaudeAccount } from '../../shared/types';
import './NamePromptModal.css';

interface NamePromptModalProps {
  isOpen: boolean;
  title: string;
  placeholder: string;
  defaultValue: string;
  onConfirm: (name: string, path?: string, claudeAccountId?: string | null) => void;
  onCancel: () => void;
  /** Show an optional path selector for group creation */
  showPathSelector?: boolean;
  pathLabel?: string;
  /**
   * When provided, show a Claude account dropdown (BDHLNDR-31). The onConfirm
   * callback receives the selected accountId (or null for "use default") as
   * the third argument.
   */
  accountPicker?: {
    accounts: ClaudeAccount[];
    initialAccountId?: string | null;
    /** Override the dropdown label. Default: "Claude account". */
    label?: string;
  };
}

export const NamePromptModal: React.FC<NamePromptModalProps> = ({
  isOpen,
  title,
  placeholder,
  defaultValue,
  onConfirm,
  onCancel,
  showPathSelector = false,
  pathLabel = 'Working Directory (optional)',
  accountPicker,
}) => {
  const [value, setValue] = useState(defaultValue);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    accountPicker?.initialAccountId ?? null,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
      setSelectedPath(null);
      setSelectedAccountId(accountPicker?.initialAccountId ?? null);
      // Focus and select input after modal opens
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
    }
  }, [isOpen, defaultValue, accountPicker?.initialAccountId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    const finalName = trimmed || defaultValue;
    const finalAccountId = accountPicker ? selectedAccountId : undefined;
    onConfirm(finalName, selectedPath || undefined, finalAccountId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    }
  };

  const handleSelectPath = async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      setSelectedPath(dir);
    }
  };

  const handleModalKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
      return;
    }
    if (e.key === 'Tab') {
      const modal = e.currentTarget as HTMLElement;
      const focusable = modal.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
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
  }, [onCancel]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="name-prompt-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="name-prompt-title"
        onKeyDown={handleModalKeyDown}
      >
        <h3 id="name-prompt-title">{title}</h3>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            autoFocus
          />
          {showPathSelector && (
            <div className="path-selector">
              <label>{pathLabel}</label>
              <div className="path-selector-row">
                <input
                  type="text"
                  value={selectedPath || ''}
                  placeholder="No path selected"
                  readOnly
                  className="path-input"
                />
                <button
                  type="button"
                  onClick={handleSelectPath}
                  className="browse-btn"
                >
                  Browse...
                </button>
              </div>
            </div>
          )}
          {accountPicker && (
            <div className="path-selector">
              <label>{accountPicker.label ?? 'Claude account'}</label>
              <select
                value={selectedAccountId ?? ''}
                onChange={e => setSelectedAccountId(e.target.value || null)}
                className="path-input"
                style={{ width: '100%', padding: '10px 12px', cursor: 'pointer' }}
              >
                <option value="">
                  {accountPicker.accounts.length === 0
                    ? 'No accounts registered — will use ~/.claude'
                    : 'Use default account'}
                </option>
                {accountPicker.accounts.map(acc => (
                  <option key={acc.id} value={acc.id}>
                    {acc.label}{acc.email ? ` (${acc.email})` : ''}{acc.isDefault ? ' — default' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="modal-buttons">
            <button type="button" className="cancel-btn" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="confirm-btn">
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
