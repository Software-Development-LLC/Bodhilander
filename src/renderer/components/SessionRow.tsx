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
 * One session row in the sidebar — an `<li>` in the group's session list.
 * Rendered identically under top-level groups and sub-groups; only the drag
 * handlers differ, and those arrive as props.
 *
 * Selection lives on a real `<button>` covering the row rather than a click
 * handler on the container, so keyboard and screen-reader support come from the
 * platform. The close button and the rename input stay outside it, since
 * neither may nest inside a button.
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
    <li
      className={classes}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
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
          autoFocus
        />
      ) : (
        <button
          type="button"
          className="session-select"
          onClick={onSelect}
          onDoubleClick={onStartEdit}
          aria-current={isActive}
          title="Double-click to rename"
        >
          {account && (
            <span
              className="session-account-dot"
              style={{ background: account.color ?? '#888888' }}
              title={accountTitle(account, session)}
              aria-label={`Account: ${account.label}`}
              draggable={false}
            />
          )}
          <span className="session-info">
            <span className="session-name">{session.name}</span>
            <SessionStatsBadge sessionId={session.id} />
          </span>
          {showProvider && (
            <span className="session-provider-badge" title={`Provider: ${provider}`} draggable={false}>
              {provider}
            </span>
          )}
          <span className={`status-pill ${session.state}`} draggable={false}>{session.state}</span>
        </button>
      )}
      <button
        type="button"
        className="session-close"
        draggable={false}
        onClick={onClose}
        title="Close session"
        aria-label="Close session"
      >
        ×
      </button>
    </li>
  );
};
