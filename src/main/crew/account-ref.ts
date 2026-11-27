/**
 * A hire names its Claude account by reference only: uuid, email and label.
 * No token or config dir ever leaves the machine. Resolution is direct, by
 * uuid then email; Crew never goes through the session resolver or failover.
 */
import { resolveAccountIdentity } from '../account-identity';
import type { ClaudeAccount } from '../../shared/types';

export interface ClaudeAccountRef {
  accountUuid: string | null;
  email: string | null;
  label: string;
}

/** The reference for a local account row, read from its config dir now. */
export function accountRefFor(account: ClaudeAccount): ClaudeAccountRef {
  const identity = resolveAccountIdentity(account.configDir);
  return {
    accountUuid: identity.accountUuid,
    email: identity.email ?? account.email ?? null,
    label: account.label,
  };
}

const sameEmail = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The local row a reference names, or null (held:missing). Email decides only when the uuid is withheld. */
export function resolveAccountRef(ref: ClaudeAccountRef, accounts: ClaudeAccount[]): ClaudeAccount | null {
  const local = accounts.map((account) => ({ account, identity: resolveAccountIdentity(account.configDir) }));
  if (ref.accountUuid) {
    const byUuid = local.find((l) => l.identity.accountUuid === ref.accountUuid);
    if (byUuid) return byUuid.account;
  }
  // A row whose own uuid differs is another account, whatever its address says.
  const byEmail = local.find(
    (l) => (!ref.accountUuid || !l.identity.accountUuid) && sameEmail(l.identity.email ?? l.account.email, ref.email),
  );
  return byEmail?.account ?? null;
}
