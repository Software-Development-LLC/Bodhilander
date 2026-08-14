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
    db.prepare(`
      INSERT INTO claude_accounts (id, label, config_dir, email, color, is_default, created_at, last_used_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)
    `).run(
      input.id,
      input.label,
      input.configDir,
      input.color ?? '#888888',
      isDefault ? 1 : 0,
      createdAt.toISOString()
    );
  });
  insert();

  return {
    id: input.id,
    label: input.label,
    configDir: input.configDir,
    email: null,
    color: input.color ?? '#888888',
    isDefault,
    createdAt,
    lastUsedAt: null,
  };
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

export function setDefaultAccount(id: string): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare('UPDATE claude_accounts SET is_default = 0 WHERE is_default = 1').run();
    db.prepare('UPDATE claude_accounts SET is_default = 1 WHERE id = ?').run(id);
  });
  tx();
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
