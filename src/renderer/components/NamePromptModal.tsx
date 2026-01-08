import React, { useState, useRef, useEffect } from 'react';
import './NamePromptModal.css';

interface NamePromptModalProps {
  isOpen: boolean;
  title: string;
  placeholder: string;
  defaultValue: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export const NamePromptModal: React.FC<NamePromptModalProps> = ({
  isOpen,
  title,
  placeholder,
  defaultValue,
  onConfirm,
  onCancel,
}) => {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
      // Focus and select input after modal opens
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
    }
  }, [isOpen, defaultValue]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) {
      onConfirm(trimmed);
    } else {
      onConfirm(defaultValue);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="name-prompt-modal" onClick={e => e.stopPropagation()}>
        <h3>{title}</h3>
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
