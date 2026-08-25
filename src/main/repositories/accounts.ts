import { getDatabase } from '../database';
import { ClaudeAccount } from '../../shared/types';
import { mapAccountRow as mapRow } from './account-row';

export function getAllAccounts(): ClaudeAccount[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM claude_accounts ORDER BY is_default DESC, created_at ASC').all() as any[];
  return rows.map(mapRow);
}

export function getAccount(id: string): ClaudeAccount | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM claude_accounts WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

export function getDefaultAccount(): ClaudeAccount | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM claude_accounts WHERE is_default = 1 LIMIT 1').get();
  return row ? mapRow(row) : null;
}

export interface CreateAccountInput {
  id: string;
  label: string;
  configDir: string;
  color?: string;
  isDefault?: boolean;
}

export function createAccount(input: CreateAccountInput): ClaudeAccount {
  const db = getDatabase();
  const createdAt = new Date();
  const isDefault = input.isDefault ?? false;

  const insert = db.transaction(() => {
    if (isDefault) {
      db.prepare('UPDATE claude_accounts SET is_default = 0 WHERE is_default = 1').run();
    }
    // A new account joins the END of an order that already exists, rather than
    // sharing NULL with the unranked ones — an estate someone has ordered
    // should not have the next account inserted into the middle of it.
    //
    // Where NO order exists yet the new account stays unranked too. Giving it
    // rank 0 would put a just-created account, which may not even be logged in
    // yet, at the front of the failover queue for an estate whose owner has
    // never expressed an opinion about ordering.
    const maxRank = (db.prepare(
      'SELECT MAX(fallback_rank) AS max FROM claude_accounts'
    ).get() as { max: number | null }).max;
    const nextRank = maxRank === null ? null : maxRank + 1;

    db.prepare(`
      INSERT INTO claude_accounts (id, label, config_dir, email, color, is_default, created_at, last_used_at, fallback_rank)
      VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?)
    `).run(
      input.id,
      input.label,
      input.configDir,
      input.color ?? '#888888',
      isDefault ? 1 : 0,
      createdAt.toISOString(),
      nextRank
    );
  });
  insert();

  // Re-read rather than reconstruct: the rank was computed inside the
  // transaction and the caller's copy must agree with the row.
  return getAccount(input.id)!;
}

export interface UpdateAccountInput {
  label?: string;
  email?: string | null;
  color?: string;
}

export function updateAccount(id: string, updates: UpdateAccountInput): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.label !== undefined) {
    fields.push('label = ?');
    values.push(updates.label);
  }
  if (updates.email !== undefined) {
    fields.push('email = ?');
    values.push(updates.email);
  }
  if (updates.color !== undefined) {
    fields.push('color = ?');
    values.push(updates.color);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE claude_accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Make the account the default, demoting the incumbent in one transaction.
 * A missing id — the renderer can offer one another window already deleted —
 * returns false and touches nothing: demoting anyway would leave no default.
 */
export function setDefaultAccount(id: string): boolean {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const target = db.prepare('SELECT 1 FROM claude_accounts WHERE id = ?').get(id);
    if (!target) return false;
    db.prepare('UPDATE claude_accounts SET is_default = 0 WHERE is_default = 1').run();
    db.prepare('UPDATE claude_accounts SET is_default = 1 WHERE id = ?').run(id);
    return true;
  });
  return tx();
}

export function touchAccount(id: string): void {
  const db = getDatabase();
  db.prepare('UPDATE claude_accounts SET last_used_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id
  );
}

/**
 * Delete an account and NULL out any sessions/groups that referred to it.
 * SQLite ALTER TABLE can't add a real FK, so we enforce SET NULL semantics here.
 * Caller is responsible for removing the on-disk config directory.
 *
 * Deleting the default promotes the oldest survivor in its place (#165).
 * Without that, registered accounts and no default is a reachable state, and it
 * reads as an account setup that quietly stopped working: every session with no
 * override falls back to the legacy ~/.claude login, and the header can name
 * neither a live account nor an assigned one — so the user is told their
 * account was removed and offered nothing to move to.
 */
export function deleteAccount(id: string): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const wasDefault = db.prepare('SELECT is_default FROM claude_accounts WHERE id = ?').get(id) as
      { is_default: number } | undefined;
    db.prepare('UPDATE sessions SET claude_account_id = NULL WHERE claude_account_id = ?').run(id);
    db.prepare('UPDATE groups SET claude_account_id = NULL WHERE claude_account_id = ?').run(id);
    db.prepare('DELETE FROM claude_accounts WHERE id = ?').run(id);
    if (wasDefault?.is_default) {
      db.prepare(`
        UPDATE claude_accounts SET is_default = 1
        WHERE id = (SELECT id FROM claude_accounts ORDER BY created_at ASC LIMIT 1)
      `).run();
    }
  });
  tx();
}

// resolveAccountForSession() lives in ../account-resolver — it reads sessions
// and groups as well as accounts, so it isn't this repository's to own.

// ---------------------------------------------------------------------------
// Failover order and usage-limit cooldowns
// ---------------------------------------------------------------------------

/**
 * How long an account is held out when the CLI announced a limit without
 * saying when it lifts. Claude's usage windows are rolling five-hour ones, so
 * this is the honest upper bound rather than an optimistic guess — an account
 * released too early just fails over again, but does so after dragging a live
 * session through a restart for nothing.
 */
export const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000;

/**
 * Accounts in the order failover tries them: explicit rank first, then the
 * panel's existing order (default, then oldest) for anything unranked.
 *
 * ORDER BY puts NULL ranks last explicitly — SQLite sorts NULL FIRST by
 * default, which would hand an unranked account priority over the order the
 * user actually set.
 */
export function getAccountsInFallbackOrder(): ClaudeAccount[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM claude_accounts
    ORDER BY fallback_rank IS NULL, fallback_rank, is_default DESC, created_at ASC
  `).all() as any[];
  return rows.map(mapRow);
}

/** Write an explicit failover order. Ids not listed keep whatever rank they had. */
export function setFallbackOrder(orderedIds: string[]): void {
  const db = getDatabase();
  const stmt = db.prepare('UPDATE claude_accounts SET fallback_rank = ? WHERE id = ?');
  const tx = db.transaction(() => {
    orderedIds.forEach((id, index) => stmt.run(index, id));
  });
  tx();
}

/**
 * Record that `id` has run out of quota until `until`.
 *
 * Extends rather than replaces: two sessions on the same account hit the wall
 * seconds apart, and the second one's message is usually the vaguer of the two
 * (no "resets at" line, so the default window). Taking the later of the two
 * stops a precise reset time from being overwritten by a generic one.
 */
export function markAccountLimited(id: string, until: Date): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE claude_accounts
    SET limited_at = COALESCE(limited_at, ?),
        limited_until = CASE
          WHEN limited_until IS NULL OR limited_until < ? THEN ?
          ELSE limited_until
        END
    WHERE id = ?
  `).run(new Date().toISOString(), until.toISOString(), until.toISOString(), id);
}

/** Clear a cooldown — the limit lifted, or the user cleared it by hand. */
export function clearAccountLimit(id: string): void {
  const db = getDatabase();
  db.prepare(
    'UPDATE claude_accounts SET limited_until = NULL, limited_at = NULL WHERE id = ?'
  ).run(id);
}

/**
 * True when the account can take work right now. A cooldown that has already
 * expired is not a limit: nothing sweeps the column, so every reader has to
 * decide expiry against the clock, and this is the one place that does it.
 */
export function isAccountHealthy(account: ClaudeAccount, now: Date = new Date()): boolean {
  return account.limitedUntil === null || account.limitedUntil.getTime() <= now.getTime();
}
