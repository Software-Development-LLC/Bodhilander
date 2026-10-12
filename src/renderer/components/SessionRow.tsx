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
  /** Offered only when the folder is missing: pick where it lives now. */
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

function rowClasses(state: {
  isActive: boolean;
  isFocused: boolean;
  isDragging: boolean;
  dropPosition: string | null;
  needsRelink: boolean;
}): string {
  return [
    'session',
    state.isActive && 'active',
    state.isFocused && 'item-focused',
    state.isDragging && 'dragging',
    state.dropPosition && `drop-${state.dropPosition}`,
    state.needsRelink && 'needs-relink',
  ].filter(Boolean).join(' ');
}

function AccountDot({ account, session, pending }: Readonly<{
  account: ClaudeAccount;
  session: Session;
  pending: { target: ClaudeAccount | null } | null;
}>): React.JSX.Element {
  const label = pending
    ? `Account: ${account.label}, running; assigned to ${nameOf(pending.target)}, restart to apply`
    : `Account: ${account.label}`;
  return (
    <span
      className="session-account-dot"
      style={{ background: account.color ?? '#888888' }}
      title={accountTitle(account, session, pending)}
      aria-label={label}
      draggable={false}
    />
  );
}

/**
 * Decorative while the dot beside it names the account — but when the pty is
 * on a deleted account there is no dot, and then this is the only thing on the
 * row with anything to say.
 */
function PendingSwitchGlyph({ account, pending }: Readonly<{
  account: ClaudeAccount | null;
  pending: { target: ClaudeAccount | null };
}>): React.JSX.Element {
  return (
    <span
      className="session-account-pending"
      title="Account switch pending — restart to apply"
      aria-hidden={account ? true : undefined}
      role={account ? undefined : 'img'}
      aria-label={account ? undefined : `Account switch pending; restart to run under ${nameOf(pending.target)}`}
    >
      ↻
    </span>
  );
}

/** A glyph AND a count: neither says on its own how many are watching what. */
function WatchingBadge({ count, names }: Readonly<{ count: number; names?: string[] }>): React.JSX.Element {
  return (
    <span
      className="session-watching"
      title={names?.length ? `Watching now: ${names.join(', ')}` : `${count} watching now`}
      aria-label={`${count} watching now`}
    >
      👁 {count}
    </span>
  );
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
  const classes = rowClasses({
    isActive,
    isFocused,
    isDragging,
    dropPosition,
    needsRelink: !!session.workingDirMissing,
  });

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
          {account && <AccountDot account={account} session={session} pending={pendingSwitch} />}
          {pendingSwitch && <PendingSwitchGlyph account={account} pending={pendingSwitch} />}
          <span className="session-info">
            <span className="session-name">{session.name}</span>
            {!!watchingCount && watchingCount > 0 && (
              <WatchingBadge count={watchingCount} names={watchingNames} />
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
      {session.workingDirMissing && onRelink && (
        <button
          type="button"
          className="session-relink"
          draggable={false}
          title={`${session.workingDir || 'This session has no folder set'} is not on this machine — choose where it lives now`}
          aria-label={`Relink ${session.name}: working directory not found`}
          onClick={onRelink}
        >
          Relink
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
