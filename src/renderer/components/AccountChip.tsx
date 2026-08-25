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
}

/**
 * Swatch for an account that has no colour of its own — every account
 * registered before #165 started assigning them from the sidebar palette.
 * Matches the repository's own default so old and new rows agree.
 */
const DEFAULT_SWATCH = '#888888';

/**
 * One account, named the same way everywhere (#165).
 *
 * An account has no email until a login records one, and not every login
 * does; the oldest accounts are all the same grey. So neither the swatch nor
 * the email identifies an account on its own.
 * The label always carries the identity; the swatch is decoration (aria-hidden,
 * next to real text) and the email is enrichment.
 *
 * Which is why a missing email renders nothing at all. This chip once fell
 * back to "Not yet logged in", which put that text beside a Claude Code that
 * was actively producing output and being billed. An absent address is not a
 * login state, and the two are answered from different places: callers that
 * want to report a login pass a resolved one and render it themselves.
 */
export const AccountChip: React.FC<AccountChipProps> = ({
  account,
  size = 'sm',
  detail,
  announceDetail = false,
  emptyLabel = 'Default (~/.claude)',
}) => {
  const label = account ? account.label : emptyLabel;

  // Trimmed, and blank treated as missing. A stored row can carry an empty or
  // padded address; the chip has one line of room for "label email", so it may
  // not spend it on whitespace, nor let the tooltip disagree with the text.
  const trimmedEmail = account?.email?.trim();
  const email = trimmedEmail || null;

  // Same reasoning: an account row written with an empty colour falls back to
  // the shared default rather than painting the swatch with nothing.
  let swatch = DEFAULT_SWATCH;
  if (account?.color) swatch = account.color;

  const titleParts = [`Claude account: ${label}`];
  if (trimmedEmail) titleParts.push(` (${trimmedEmail})`);
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
        style={{ background: swatch }}
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
