/**
 * Reading an arrival report. Shared because both halves ask the same two
 * questions of it: main decides nothing yet, and the renderer decides whether
 * the report is worth raising — and a second copy of "does this still need a
 * person" would eventually disagree with the first.
 */

import type { ArrivalAccountItem, ArrivalReport } from './types';

/**
 * Accounts the user still has to sign in to.
 *
 * `undefined` means the login evidence could not be read, which is not the
 * same as "never logged in": Claude rewrites the profile file about once a
 * minute, so a torn read is ordinary. Sending someone to re-authenticate on
 * that basis is worse than saying nothing.
 */
export function accountsNeedingSignIn(report: ArrivalReport): ArrivalAccountItem[] {
  return report.accounts.filter((a) => a.loggedIn === false);
}

/**
 * Whether anything in the report is still waiting on a person. A restore onto
 * the same machine, with every folder present and every account already signed
 * in, has nothing to say and should say nothing.
 */
export function hasOutstandingWork(report: ArrivalReport): boolean {
  return (
    report.needsRelink.length > 0 ||
    accountsNeedingSignIn(report).length > 0 ||
    report.providersNeedingKeys.length > 0
  );
}
