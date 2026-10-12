import log from 'electron-log';

import { AccountSwitchResult, ClaudeAccount } from '../shared/types';
import { getDatabase } from './database';
import { resolveAccountForSession } from './account-resolver';
import { carryTranscript, legacyClaudeConfigDir } from './conversation-transcript';
import * as accountsRepo from './repositories/accounts';
import * as groupsRepo from './repositories/groups';
import * as sessionsRepo from './repositories/sessions';

/**
 * Reassigning a session's Claude account (BDHLNDR-31) is more than a column
 * write: the account only reaches the CLI as CLAUDE_CONFIG_DIR, and that env
 * var is baked into the pty at spawn time (see PtyManager.buildAgentSpawn). A
 * live session therefore keeps billing the old account until its pty respawns.
 *
 * This module owns the two follow-ups the column write can't do on its own:
 *   1. eagerly copy the in-flight conversation transcript into the new
 *      account's config dir, so the respawn can still `--resume` it, and
 *   2. report which sessions changed effective account, so the renderer knows
 *      which ptys to restart.
 *
 * The copy is an optimisation, not the guarantee (#164): a live pty keeps
 * appending to the old account's tree until it dies, so the authoritative
 * carry happens at launch in conversation-transcript.ts.
 */

/** Config dir a session runs under when no account resolves (pre-accounts behavior). */
function configDirOf(account: ClaudeAccount | null): string {
  return account?.configDir ?? legacyClaudeConfigDir();
}

/**
 * Point a single session at `accountId` (null = inherit from its group).
 * Returns the sessions needing a pty restart — empty when the effective
 * account didn't actually move (e.g. clearing an override that already
 * matched the group's account).
 */
export function assignSessionAccount(
  sessionId: string,
  accountId: string | null,
): AccountSwitchResult {
  const before = resolveAccountForSession(sessionId);
  sessionsRepo.updateSession(sessionId, { claudeAccountId: accountId });
  const after = resolveAccountForSession(sessionId);

  if ((before?.id ?? null) === (after?.id ?? null)) {
    // The write still happened and still means something — the session is now
    // pinned to this account instead of inheriting it, so a later group switch
    // will leave it behind. Nothing restarts, so the caller is the only thing
    // that can say so (#214).
    return {
      affectedSessionIds: [],
      outcome: { account: after, unchangedSessionIds: [sessionId], overriddenSessionIds: [] },
    };
  }

  rehomeConversation(sessionId, before, after);
  return {
    affectedSessionIds: [sessionId],
    outcome: { account: after, unchangedSessionIds: [], overriddenSessionIds: [] },
  };
}

/**
 * Point a group at `accountId` (null = fall back to the default account).
 * Sessions carrying their own override are unaffected; the rest inherit the
 * change and are returned for restart.
 */
export function assignGroupAccount(
  groupId: string,
  accountId: string | null,
): AccountSwitchResult {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT id, claude_account_id FROM sessions WHERE group_id = ?'
  ).all(groupId) as { id: string; claude_account_id: string | null }[];
  const ids = rows.map(row => row.id);

  const before = new Map(ids.map(id => [id, resolveAccountForSession(id)]));
  groupsRepo.updateGroup(groupId, { claudeAccountId: accountId });

  const affectedSessionIds: string[] = [];
  const unchangedSessionIds: string[] = [];
  for (const id of ids) {
    const prev = before.get(id) ?? null;
    const next = resolveAccountForSession(id);
    if ((prev?.id ?? null) === (next?.id ?? null)) {
      unchangedSessionIds.push(id);
      continue;
    }
    rehomeConversation(id, prev, next);
    affectedSessionIds.push(id);
  }

  return {
    affectedSessionIds,
    outcome: {
      account: groupAccount(accountId),
      unchangedSessionIds,
      // Read from the pre-write rows: a group switch never touches a session's
      // own column, so these are the sessions it was structurally unable to
      // move — a different fact from "already there", and the one that
      // explains a group switch that appears to do nothing (#214).
      overriddenSessionIds: rows.filter(row => row.claude_account_id !== null).map(row => row.id),
    },
  };
}

/**
 * The account a group resolves to after being pointed at `accountId`.
 *
 * Mirrors resolveAccountForSession's tail: null means "use the default", and a
 * reference to an account that no longer exists falls through to the default
 * the same way a missing assignment does.
 */
function groupAccount(accountId: string | null): ClaudeAccount | null {
  const picked = accountId ? accountsRepo.getAccount(accountId) : null;
  return picked ?? accountsRepo.getDefaultAccount();
}

/**
 * Best-effort eager copy of the conversation into the new account's tree.
 *
 * The authoritative carry now happens at LAUNCH (PtyManager.buildAgentSpawn,
 * #164), which searches every known config dir — so a failure here is not a
 * lost conversation and must not be treated as one. Dropping the stored UUID
 * on failure, as this used to, destroyed live conversations: for a running
 * session the transcript is still being appended to in the OLD account's tree
 * and simply hadn't arrived yet.
 */
function rehomeConversation(
  sessionId: string,
  from: ClaudeAccount | null,
  to: ClaudeAccount | null,
): void {
  const uuid = sessionsRepo.getClaudeSessionId(sessionId);
  if (!uuid) return; // Never launched — nothing to carry.

  if (carryTranscript(uuid, configDirOf(from), configDirOf(to))) {
    log.info(`[Accounts] Conversation ${uuid} is readable from the new account for ${sessionId}`);
    return;
  }

  log.warn(
    `[Accounts] Could not eagerly carry conversation ${uuid} for ${sessionId}; ` +
    'the launch-time search will retry when the pty respawns.'
  );
}
