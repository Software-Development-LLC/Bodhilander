import React from 'react';
import { ClaudeAccount } from '../../shared/types';
import './AccountChip.css';

export interface AccountChipProps {
  /** The account to name. null renders the no-account login (legacy ~/.claude). */
  account: ClaudeAccount | null;
  /** 'sm' for inline chrome (session header), 'md' for list rows (accounts panel). Default 'sm'. */
  size?: 'sm' | 'md';
  /** Appended to the tooltip after an em dash, e.g. "running under this account". */
  detail?: string;
  /**
   * Also rendered as text inside the chip, so `detail` is available to a screen
   * reader rather than living only in a `title` on a non-focusable span. Off by
   * default: in a list of accounts the detail is the same on every row.
   */
  announceDetail?: boolean;
  /** Label used when `account` is null. Default 'Default (~/.claude)'. */
  emptyLabel?: string;
  /**
   * Rendered in place of the email for an account that never captured one.
   * Only the accounts panel passes it: there "Not yet logged in" describes a
   * row the user can act on. Nowhere else may say it — see below.
   */
  noEmailLabel?: string;
}

/**
 * One account, named the same way everywhere (#165).
 *
 * An account has no email until a login writes one, and on macOS the login
 * usually never writes one; accounts registered before #165 are all the same
 * grey. So neither the swatch nor the email identifies an account on its own.
 * The label always carries the identity; the swatch is decoration (aria-hidden,
 * next to real text) and the email is enrichment.
 *
 * Which is why a missing email renders nothing at all by default. It used to
 * fall back to "Not yet logged in", and in the session header that produced a
 * chip reading "Work — Not yet logged in" next to a Claude Code that was
 * actively producing output and being billed. On the setup where no email is
 * ever captured that was not an edge case but the normal reading, and on the
 * back of #164 — where a switch silently did nothing — "not logged in" is
 * exactly the wrong thing to tell someone about a session that is working.
 */
export const AccountChip: React.FC<AccountChipProps> = ({
  account,
  size = 'sm',
  detail,
  announceDetail = false,
  emptyLabel = 'Default (~/.claude)',
  noEmailLabel,
}) => {
  const label = account ? account.label : emptyLabel;
  const email = account ? (account.email || noEmailLabel) : null;

  const titleParts = [`Claude account: ${label}`];
  if (account?.email) titleParts.push(` (${account.email})`);
  if (detail) titleParts.push(` — ${detail}`);

  return (
    <span
      className={['account-chip', `account-chip-${size}`].join(' ')}
      title={titleParts.join('')}
      draggable={false}
    >
      <span
        className="account-chip-swatch"
        aria-hidden="true"
        style={{ background: account?.color || '#888888' }}
      />
      <span className="account-chip-text">
        <span className="account-chip-label">{label}</span>
        {email && <span className="account-chip-email">{email}</span>}
        {announceDetail && detail && <span className="sr-only"> — {detail}</span>}
      </span>
    </span>
  );
};

export default AccountChip;
