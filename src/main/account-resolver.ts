import { ClaudeAccount } from '../shared/types';
import { getDatabase } from './database';
import { mapAccountRow } from './repositories/account-row';
import { getAccountsInFallbackOrder, isAccountHealthy } from './repositories/accounts';
import { isUsagePressured } from './usage-store';

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

/** The group's own account, else the default, before any limit or usage steering. */
export function candidateAccountForGroup(groupId: string | null): ClaudeAccount | null {
  const db = getDatabase();
  let candidate: ClaudeAccount | null = null;
  if (groupId) {
    const row = db.prepare(`
      SELECT a.*
      FROM groups g
      LEFT JOIN claude_accounts a ON a.id = g.claude_account_id
      WHERE g.id = ?
    `).get(groupId) as any;
    if (row?.id) candidate = mapAccountRow(row);
  }
  if (!candidate) {
    const fallback = db.prepare(
      'SELECT * FROM claude_accounts WHERE is_default = 1 LIMIT 1'
    ).get() as any;
    candidate = fallback ? mapAccountRow(fallback) : null;
  }
  return candidate;
}

/**
 * Resolve the Claude account a run's gates launch under (CO-722 / #327).
 * Fallback chain: the run's group → the default account → null (ambient
 * `~/.claude`, the pre-#327 behaviour). Mirrors `resolveAccountForSession` but
 * keyed on a group rather than a session, because a gate belongs to a run, not
 * a terminal session.
 */
export function resolveAccountForGroup(groupId: string | null, now: Date = new Date()): ClaudeAccount | null {
  try {
    const chosen = candidateAccountForGroup(groupId);
    if (!chosen) return null;

    // Step aside from a rate-limited account. A gate launches under a fixed
    // CLAUDE_CONFIG_DIR, so pointing it at an account known to be spent (its
    // `limitedUntil` still in the future) would just burn a launch into the
    // same 429. When the chosen account is limited, prefer the next healthy one
    // in fallback order; if none is healthy there is nothing better to do, so
    // keep the original rather than return nothing.
    // Near-limit accounts are a last resort: a healthy one below the usage
    // warning threshold is preferred, then the chosen one if it is healthy.
    const chosenHealthy = isAccountHealthy(chosen, now);
    if (chosenHealthy && !isUsagePressured(chosen.id, now)) return chosen;
    const others = getAccountsInFallbackOrder().filter(
      (a) => a.id !== chosen.id && isAccountHealthy(a, now),
    );
    const relieved = others.find((a) => !isUsagePressured(a.id, now));
    if (relieved) return relieved;
    if (chosenHealthy) return chosen;
    return others[0] ?? chosen;
  } catch {
    // A gate spawn must not fail because the DB is unopened or the accounts
    // table is absent (a partial fixture, an early boot): fall back to ambient.
    return null;
  }
}
