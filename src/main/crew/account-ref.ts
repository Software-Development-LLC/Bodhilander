/**
 * A hire names its Claude account by reference only: uuid, email and label.
 * No token or config dir ever leaves the machine. Resolution is direct, by
 * uuid then email; Crew never goes through the session resolver or failover.
 */
import { resolveAccountIdentity } from '../account-identity';
import type Database from 'better-sqlite3';
import type { ClaudeAccount } from '../../shared/types';
import type { carryTranscript } from '../conversation-transcript';
import type { AccountRef } from './protocol';
import { carryHireSessions, type CarryResult } from './session-carry';
import type { EditInput } from './sync';

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

/** The reference on the wire: every key a non-empty string, so a hire is never pointed at an unknown uuid. */
export function wireAccountRef(ref: ClaudeAccountRef): AccountRef | null {
  if (!ref.accountUuid || !ref.email || !ref.label) return null;
  return { accountUuid: ref.accountUuid, email: ref.email, label: ref.label };
}

export function accountChangeEdit(hireId: string, ref: AccountRef): EditInput {
  return { op: 'update', kind: 'hire', objectId: hireId, fields: { accountRef: ref } };
}

export interface AccountChangeDeps {
  db: Database.Database;
  sendEdit(input: EditInput): string;
  configDirOf(accountId: string): string | null;
  carry?: typeof carryTranscript;
}

/** Change account: tell the Hub, then carry each thread's session to the new config dir. Takes effect on the next run. */
export function changeHireAccount(
  deps: AccountChangeDeps,
  hireId: string,
  to: ClaudeAccount,
): { editId: string; carried: CarryResult } | 'unknown-account' {
  const ref = wireAccountRef(accountRefFor(to));
  if (ref === null) return 'unknown-account';
  const editId = deps.sendEdit(accountChangeEdit(hireId, ref));
  const carried = carryHireSessions(deps.db, hireId, { id: to.id, configDir: to.configDir }, deps.configDirOf, deps.carry);
  return { editId, carried };
}
