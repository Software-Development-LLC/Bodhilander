import React from 'react';
import { ClaudeAccount, PROVIDER_LABELS, Session } from '../../shared/types';
import { SessionStatsBadge } from './SessionStatsBadge';

interface SessionRowProps {
  session: Session;
  isActive: boolean;
  isFocused: boolean;
  isDragging: boolean;
  /** 'before' | 'after' when this row is the current drop target. */
  dropPosition: string | null;
  draggable: boolean;
  account: ClaudeAccount | null;

  isEditing: boolean;
  editingName: string;
  onEditingNameChange: (name: string) => void;
  onStartEdit: () => void;
  onFinishEdit: () => void;
  onCancelEdit: () => void;

  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onClose: () => void;
}

function accountTitle(account: ClaudeAccount, session: Session): string {
  const email = account.email ? ` (${account.email})` : '';
  const scope = session.claudeAccountId ? ' — session override' : ' — inherited';
  return `Claude account: ${account.label}${email}${scope}`;
}

/**
 * One session row in the sidebar. Rendered identically under top-level groups
 * and sub-groups; only the drag handlers differ, and those arrive as props.
 *
 * Presented as an `option` inside the group's `listbox` (see `.group-sessions`).
 */
export const SessionRow: React.FC<SessionRowProps> = ({
  session, isActive, isFocused, isDragging, dropPosition, draggable, account,
  isEditing, editingName, onEditingNameChange, onStartEdit, onFinishEdit, onCancelEdit,
  onSelect, onContextMenu, onDragStart, onDragEnd, onDragOver, onDrop, onClose,
}) => {
  const classes = [
    'session',
    isActive ? 'active' : '',
    isFocused ? 'item-focused' : '',
    isDragging ? 'dragging' : '',
    dropPosition ? `drop-${dropPosition}` : '',
  ].filter(Boolean).join(' ');

  const provider = PROVIDER_LABELS[session.provider] ?? session.provider;
  const showProvider = session.shellType === 'claude' && session.provider !== 'claude';

  return (
    <div
      className={classes}
      // A selectable item in the group's session list. The sidebar drives focus
      // itself (Ctrl+Q + arrows), so this row is not in the tab order.
      role="option"
      aria-selected={isActive}
      tabIndex={-1}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      onDoubleClick={() => { if (!isEditing) onStartEdit(); }}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {account && (
        <span
          className="session-account-dot"
          style={{ background: account.color ? account.color : '#888888' }}
          title={accountTitle(account, session)}
          aria-label={`Account: ${account.label}`}
          draggable={false}
        />
      )}
      <div className="session-info">
        {isEditing ? (
          <input
            className="session-name-input"
            value={editingName}
            onChange={(e) => onEditingNameChange(e.target.value)}
            onBlur={onFinishEdit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') onFinishEdit();
              if (e.key === 'Escape') onCancelEdit();
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span className="session-name" title="Double-click to rename">
            {session.name}
          </span>
        )}
        <SessionStatsBadge sessionId={session.id} />
      </div>
      {showProvider && (
        <span className="session-provider-badge" title={`Provider: ${provider}`} draggable={false}>
          {provider}
        </span>
      )}
      <span className={`status-pill ${session.state}`} draggable={false}>{session.state}</span>
      <button
        className="session-close"
        draggable={false}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close session"
        aria-label="Close session"
      >
        ×
      </button>
    </div>
  );
};
