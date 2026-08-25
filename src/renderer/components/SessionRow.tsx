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
  /**
   * The account this row reports. While a pty is running that is the account
   * it ACTUALLY spawned under, not the database assignment (#165) — the two
   * differ for as long as a switch goes unapplied.
   */
  account: ClaudeAccount | null;
  /**
   * Set when the session is assigned to an account it is not running under —
   * `target` being where a restart would take it (null = the default login).
   * The sidebar is the only place a non-active session's account is visible at
   * all, inactive headers being display:none, so a group switch the user
   * declined to restart would otherwise show four sessions as moved while all
   * four kept billing the old login.
   */
  pendingSwitch?: { target: ClaudeAccount | null } | null;
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
  /** Offered only for a needs-relink session: pick the folder it lives in now. */
  onRelink?: () => void;
}

function nameOf(account: ClaudeAccount | null): string {
  if (!account) return 'the default login';
  return account.email ? `${account.label} (${account.email})` : account.label;
}

function accountTitle(
  account: ClaudeAccount,
  session: Session,
  pending: { target: ClaudeAccount | null } | null,
): string {
  const scope = session.claudeAccountId ? ' — session override' : ' — inherited';
  const suffix = pending ? `; assigned to ${nameOf(pending.target)}, restart to apply` : '';
  return `Claude account: ${nameOf(account)}${scope}${suffix}`;
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
  pendingSwitch = null, watchingCount, watchingNames,
  isEditing, editingName, onEditingNameChange, onStartEdit, onFinishEdit, onCancelEdit,
  onSelect, onContextMenu, onDragStart, onDragEnd, onDragOver, onDrop, onClose, onRelink,
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
              title={accountTitle(account, session, pendingSwitch)}
              aria-label={
                pendingSwitch
                  ? `Account: ${account.label}, running; assigned to ${nameOf(pendingSwitch.target)}, restart to apply`
                  : `Account: ${account.label}`
              }
              draggable={false}
            />
          )}
          {/* Accounts registered before #165 are all the same grey and no UI
              lets a user recolour one, so tinting the dot could never have
              carried this. Decorative while the dot beside it names the account
              — but when the pty is on a deleted account there is no dot, and
              then this is the only thing on the row with anything to say. */}
          {pendingSwitch && (
            <span
              className="session-account-pending"
              title="Account switch pending — restart to apply"
              aria-hidden={account ? true : undefined}
              role={account ? undefined : 'img'}
              aria-label={account
                ? undefined
                : `Account switch pending; restart to run under ${nameOf(pendingSwitch.target)}`}
            >
              ↻
            </span>
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
          {session.state === 'needs-relink' && onRelink ? (
            <button
              type="button"
              className="status-pill needs-relink"
              draggable={false}
              title={`${session.workingDir || 'This folder'} is not on this machine — choose where it lives now`}
              onClick={(e) => { e.stopPropagation(); onRelink(); }}
            >
              relink
            </button>
          ) : (
            <span className={`status-pill ${session.state}`} draggable={false}>{session.state}</span>
          )}
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
