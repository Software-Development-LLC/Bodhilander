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
  /**
   * Guests watching this session right now.
   *
   * Presence at a glance answers "is anyone looking at this?" without the
   * owner having to go and check — which is the whole point: silent read
   * access to a live terminal is the same class of harm as silent write
   * access.
   */
  watchingCount?: number;
  /** Handles for the tooltip, so the badge names people rather than a number. */
  watchingNames?: string[];

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
  watchingCount, watchingNames,
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
          // Explicit ternary, not `||`/`??`: `isActive ?? undefined` would keep
          // `false` (it is not nullish) and re-emit aria-current="false".
          aria-current={isActive ? true : undefined}
          // The sidebar has its own roving navigation (Ctrl+Q then arrows), and
          // the close button is already a tab stop. Keeping this out of the tab
          // order avoids two stops per row (#141).
          tabIndex={-1}
          title="Double-click anywhere on the row to rename"
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
            {!!watchingCount && watchingCount > 0 && (
              // A glyph AND a count: an eye alone does not say how many, and a
              // number alone does not say what it counts.
              <span
                className="session-watching"
                title={
                  watchingNames?.length
                    ? `Watching now: ${watchingNames.join(', ')}`
                    : `${watchingCount} watching now`
                }
                aria-label={`${watchingCount} watching now`}
              >
                👁 {watchingCount}
              </span>
            )}
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
