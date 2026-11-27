/**
 * A hire names its Claude account by reference only: uuid, email and label.
 * No token or config dir ever leaves the machine. Resolution is direct, by
 * uuid then email; Crew never goes through the session resolver or failover.
 */
import { resolveAccountIdentity } from '../account-identity';
import type Database from 'better-sqlite3';
import log from 'electron-log';
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

/** The local row a reference names, or null (held:missing). Email decides only when the uuid is withheld, and only if one row has it. */
export function resolveAccountRef(ref: ClaudeAccountRef, accounts: ClaudeAccount[]): ClaudeAccount | null {
  const local = accounts.map((account) => ({ account, identity: resolveAccountIdentity(account.configDir) }));
  if (ref.accountUuid) {
    const byUuid = local.find((l) => l.identity.accountUuid === ref.accountUuid);
    if (byUuid) return byUuid.account;
  }
  // A row whose own uuid differs is another account, whatever its address says.
  const byEmail = local.filter(
    (l) => (!ref.accountUuid || !l.identity.accountUuid) && sameEmail(l.identity.email ?? l.account.email, ref.email),
  );
  return byEmail.length === 1 ? byEmail[0].account : null;
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

export type AccountChangeOutcome = { editId: string } | { refused: 'unknown-account' | 'hire-not-synced' | 'send-failed' };

const PENDING_PREFIX = 'account-change:';

interface PendingChange {
  hireId: string;
  accountId: string;
  configDir: string;
  applied?: boolean;
}

/**
 * Changes a hire's account. The pending change is stored beside the outbox edit, so
 * sessions still move when the Hub applies it after a restart; they take effect on the next run.
 */
export class AccountChanger {
  constructor(private readonly deps: AccountChangeDeps) {}

  change(hireId: string, to: ClaudeAccount): AccountChangeOutcome {
    const ref = wireAccountRef(accountRefFor(to));
    if (ref === null) return { refused: 'unknown-account' };
    if (!this.synced(hireId)) return { refused: 'hire-not-synced' };
    let editId: string;
    try {
      editId = this.deps.sendEdit(accountChangeEdit(hireId, ref));
    } catch (err) {
      log.warn('[Crew] could not queue an account change', err);
      return { refused: 'send-failed' };
    }
    const change: PendingChange = { hireId, accountId: to.id, configDir: to.configDir };
    this.deps.db.prepare(`INSERT OR REPLACE INTO crew_sync_state (key, value) VALUES (?, ?)`).run(PENDING_PREFIX + editId, JSON.stringify(change));
    return { editId };
  }

  /** A fence-only row has rev 0: the Hub has never sent this hire's object, so there is no rev to edit against. */
  private synced(hireId: string): boolean {
    const row = this.deps.db.prepare(`SELECT rev FROM crew_hire_cache WHERE hire_id = ?`).get(hireId) as { rev: number } | undefined;
    return !!row && row.rev > 0;
  }

  /** Feed every edit_result here. Returns what was carried, or null when the frame is not an applied account change. */
  onEditResult(frame: Pick<EditResultFrame, 'id' | 'result'>): CarryResult | null {
    const key = PENDING_PREFIX + frame.id;
    const change = this.read(key);
    if (!change || change.applied) return null;
    if (frame.result !== 'applied') {
      this.forget(key);
      return null;
    }
    this.write(key, { ...change, applied: true });
    return this.carry(key, change);
  }

  /** Carries every applied change whose carry failed, and forgets every change whose edit is no longer queued. */
  settle(): CarryResult[] {
    const rows = this.deps.db.prepare(`SELECT key, value FROM crew_sync_state WHERE key LIKE ?`).all(`${PENDING_PREFIX}%`) as {
      key: string;
      value: string;
    }[];
    const queued = this.deps.db.prepare(`SELECT 1 FROM crew_outbox_local WHERE id = ? AND state IN ('pending', 'parked')`);
    const carried: CarryResult[] = [];
    for (const row of rows) {
      const change = pendingChange(row.value);
      if (change?.applied) carried.push(this.carry(row.key, change));
      else if (!change || !queued.get(row.key.slice(PENDING_PREFIX.length))) this.forget(row.key);
    }
    return carried;
  }

  private carry(key: string, change: PendingChange): CarryResult {
    const { db, configDirOf, carry } = this.deps;
    const carried = carryHireSessions(db, change.hireId, { id: change.accountId, configDir: change.configDir }, configDirOf, carry);
    this.forget(key);
    return carried;
  }

  private read(key: string): PendingChange | null {
    const row = this.deps.db.prepare(`SELECT value FROM crew_sync_state WHERE key = ?`).get(key) as { value: string } | undefined;
    return row ? pendingChange(row.value) : null;
  }

  private write(key: string, change: PendingChange): void {
    this.deps.db.prepare(`UPDATE crew_sync_state SET value = ? WHERE key = ?`).run(JSON.stringify(change), key);
  }

  private forget(key: string): void {
    this.deps.db.prepare(`DELETE FROM crew_sync_state WHERE key = ?`).run(key);
  }
}

function pendingChange(stored: string): PendingChange | null {
  try {
    const v: unknown = JSON.parse(stored);
    if (typeof v !== 'object' || v === null) return null;
    const { hireId, accountId, configDir, applied } = v as Record<string, unknown>;
    if (typeof hireId !== 'string' || typeof accountId !== 'string' || typeof configDir !== 'string') return null;
    return { hireId, accountId, configDir, applied: applied === true };
  } catch {
    return null;
  }
}
