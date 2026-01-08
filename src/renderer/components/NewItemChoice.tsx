import React, { useEffect, useRef } from 'react';
import './NewItemChoice.css';

interface NewItemChoiceProps {
  isOpen: boolean;
  x: number;
  y: number;
  onNewSession: () => void;
  onNewSubGroup: () => void;
  onClose: () => void;
}

export const NewItemChoice: React.FC<NewItemChoiceProps> = ({
  isOpen,
  x,
  y,
  onNewSession,
  onNewSubGroup,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    // Delay adding listeners to avoid immediate close
    setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Adjust position to stay within viewport
  const adjustedX = Math.min(x, window.innerWidth - 160);
  const adjustedY = Math.min(y, window.innerHeight - 100);

  return (
    <div
      ref={menuRef}
      className="new-item-choice"
      style={{ left: adjustedX, top: adjustedY }}
    >
      <button onClick={onNewSession}>
        <span className="choice-icon">+</span>
        New Session
      </button>
      <button onClick={onNewSubGroup}>
        <span className="choice-icon">+</span>
        New Sub-Group
      </button>
    </div>
  );
};
