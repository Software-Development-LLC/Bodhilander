import React from 'react';
import { AccountFailoverEvent } from '../../shared/types';
import { AccountChip } from './AccountChip';
import { Notice } from './Notice';

export interface FailoverNoticeProps {
  event: AccountFailoverEvent;
  onDismiss: () => void;
  /** Opens Settings → Claude accounts, where the order and cooldowns live. */
  onOpenAccounts: () => void;
}

/**
 * What just happened to your sessions, said once, in the window.
 *
 * A desktop notification already fires, but it is the wrong and only channel
 * on its own: it is gone in five seconds, it is invisible to anyone who has
 * notifications off, and it cannot be gone back to. An account switch is a
 * thing the app did on its own initiative to work the user did not finish, so
 * it earns a line in the interface that stays until it is dismissed.
 *
 * The blocked cases are the ones that most need saying. "Everything you have
 * is spent" is not a smaller event than a successful switch — it is the one
 * where the user has to do something.
 */
export const FailoverNotice: React.FC<FailoverNoticeProps> = ({ event, onDismiss, onOpenAccounts }) => {
  const blocked = event.to === null;
  const sessions = event.sessionIds.length === 1
    ? '1 session'
    : `${event.sessionIds.length} sessions`;

  return (
    <Notice
      tone={blocked ? 'warn' : 'info'}
      icon={blocked ? '!' : '⇄'}
      onDismiss={onDismiss}
      action={{ label: 'Accounts', onClick: onOpenAccounts }}
    >
      {event.reason === 'failback' ? (
        <>
          <strong>Back on your own account.</strong>{' '}
          <AccountChip account={event.to} size="sm" />{' '}
          is out of its usage limit, so {sessions} moved back.
        </>
      ) : (
        <>
          <AccountChip account={event.from} size="sm" />{' '}
          {describeLimit(event)}{' '}
          {renderOutcome(event, sessions)}
        </>
      )}
    </Notice>
  );
};

/** "hit its usage limit (back at 9:30pm)." */
function describeLimit(event: AccountFailoverEvent): string {
  if (!event.resetAt) return 'hit its usage limit.';
  return `hit its usage limit — back at ${formatReset(new Date(event.resetAt))}.`;
}

function renderOutcome(event: AccountFailoverEvent, sessions: string): React.ReactNode {
  if (event.blocked === 'no-healthy-account') {
    return 'Every other account is limited too, so nothing moved.';
  }
  return (
    <>
      {sessions} moved to <AccountChip account={event.to} size="sm" />.
    </>
  );
}

/** "9:30 PM", or "Tue 9:30 PM" when the reset is not today. */
function formatReset(resetAt: Date, now: Date = new Date()): string {
  const time = resetAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (resetAt.toDateString() === now.toDateString()) return time;
  return `${resetAt.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}
