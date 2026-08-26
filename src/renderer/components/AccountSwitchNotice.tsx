import React from 'react';
import { AccountSwitchReport } from '../accountSwitchReport';
import { AccountChip } from './AccountChip';
import { Notice } from './Notice';

export interface AccountSwitchNoticeProps {
  report: AccountSwitchReport;
  onDismiss: () => void;
}

/**
 * What an account switch did, when it did not restart anything (#214).
 *
 * Wears the same shell as the failover notice on purpose: from the user's side
 * these are one event — "your sessions are on a different account now" — and
 * the only difference is who initiated it.
 */
export const AccountSwitchNotice: React.FC<AccountSwitchNoticeProps> = ({ report, onDismiss }) => (
  <Notice tone={report.tone} icon={report.tone === 'muted' ? '=' : '⇄'} onDismiss={onDismiss}>
    {report.prefix}
    <AccountChip account={report.account} size="sm" />
    {report.suffix}
  </Notice>
);
