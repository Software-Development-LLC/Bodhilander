import { ClaudeAccount } from '../shared/types';
import { getDatabase } from './database';
import { mapAccountRow } from './repositories/account-row';

/**
 * Resolve which Claude account a given session should launch under (BDHLNDR-31).
 * Fallback chain: session → group → default → null (legacy ~/.claude behavior).
 * Returns null if no accounts are configured, preserving pre-feature behavior.
 *
 * Lives outside repositories/accounts, and queries rather than calling into it,
 * so that both spawn-time resolution (pty-manager) and switch-time resolution
 * (account-switch) share one copy of this policy independently of that
 * repository's module shape.
 */
export function resolveAccountForSession(sessionId: string): ClaudeAccount | null {
  const db = getDatabase();

  // COALESCE encodes the session-overrides-group precedence; the join drops to
  // NULL when the referenced account no longer exists, which falls through to
  // the default below exactly as a missing assignment does.
  const row = db.prepare(`
    SELECT a.*
    FROM sessions s
    LEFT JOIN groups g ON g.id = s.group_id
    LEFT JOIN claude_accounts a
      ON a.id = COALESCE(s.claude_account_id, g.claude_account_id)
    WHERE s.id = ?
  `).get(sessionId) as any;

  if (row?.id) return mapAccountRow(row);

  const fallback = db.prepare(
    'SELECT * FROM claude_accounts WHERE is_default = 1 LIMIT 1'
  ).get() as any;
  return fallback ? mapAccountRow(fallback) : null;
}
