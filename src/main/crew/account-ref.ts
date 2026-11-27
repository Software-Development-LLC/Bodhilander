/**
 * A hire names its Claude account by reference only: uuid, email and label.
 * No token or config dir ever leaves the machine. Resolution is direct, by
 * uuid then email; Crew never goes through the session resolver or failover.
 */
import { resolveAccountIdentity } from '../account-identity';
import type Database from 'better-sqlite3';
import type { ClaudeAccount } from '../../shared/types';
import type { carryTranscript } from '../conversation-transcript';
import type { AccountRef, EditResultFrame } from './protocol';
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
  return { op: 'update', kind: 'hire', objectId: hireId, hireId, fields: { accountRef: ref } };
}

export interface AccountChangeDeps {
  db: Database.Database;
  sendEdit(input: EditInput): string;
  configDirOf(accountId: string): string | null;
  carry?: typeof carryTranscript;
}

export type AccountChangeOutcome = { editId: string } | { refused: 'unknown-account' | 'hire-not-synced' };

const PENDING_PREFIX = 'account-change:';

/**
 * Changes a hire's account. The pending change is stored beside the outbox edit, so
 * sessions still move when the Hub applies it after a restart; they take effect on the next run.
 */
export class AccountChanger {
  constructor(private readonly deps: AccountChangeDeps) {}

  change(hireId: string, to: ClaudeAccount): AccountChangeOutcome {
    const ref = wireAccountRef(accountRefFor(to));
    if (ref === null) return { refused: 'unknown-account' };
    let editId: string;
    try {
      editId = this.deps.sendEdit(accountChangeEdit(hireId, ref));
    } catch {
      return { refused: 'hire-not-synced' };
    }
    this.deps.db
      .prepare(`INSERT OR REPLACE INTO crew_sync_state (key, value) VALUES (?, ?)`)
      .run(PENDING_PREFIX + editId, JSON.stringify({ hireId, accountId: to.id, configDir: to.configDir }));
    return { editId };
  }

  /** Feed every edit_result here. Returns what was carried, or null when the frame is not an applied account change. */
  onEditResult(frame: Pick<EditResultFrame, 'id' | 'result'>): CarryResult | null {
    const key = PENDING_PREFIX + frame.id;
    const row = this.deps.db.prepare(`SELECT value FROM crew_sync_state WHERE key = ?`).get(key) as { value: string } | undefined;
    if (!row) return null;
    this.deps.db.prepare(`DELETE FROM crew_sync_state WHERE key = ?`).run(key);
    if (frame.result !== 'applied') return null;
    const change = pendingChange(row.value);
    if (change === null) return null;
    return carryHireSessions(this.deps.db, change.hireId, { id: change.accountId, configDir: change.configDir }, this.deps.configDirOf, this.deps.carry);
  }
}

function pendingChange(stored: string): { hireId: string; accountId: string; configDir: string } | null {
  try {
    const v: unknown = JSON.parse(stored);
    if (typeof v !== 'object' || v === null) return null;
    const { hireId, accountId, configDir } = v as Record<string, unknown>;
    return typeof hireId === 'string' && typeof accountId === 'string' && typeof configDir === 'string' ? { hireId, accountId, configDir } : null;
  } catch {
    return null;
  }
}
