import log from 'electron-log';

import { AccountSwitchResult, ClaudeAccount } from '../shared/types';
import { getDatabase } from './database';
import { resolveAccountForSession } from './account-resolver';
import { carryTranscript, legacyClaudeConfigDir } from './conversation-transcript';
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
    return { affectedSessionIds: [] };
  }

  rehomeConversation(sessionId, before, after);
  return { affectedSessionIds: [sessionId] };
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
  const ids = (db.prepare('SELECT id FROM sessions WHERE group_id = ?').all(groupId) as
    { id: string }[]).map(row => row.id);

  const before = new Map(ids.map(id => [id, resolveAccountForSession(id)]));
  groupsRepo.updateGroup(groupId, { claudeAccountId: accountId });

  const affectedSessionIds: string[] = [];
  for (const id of ids) {
    const prev = before.get(id) ?? null;
    const next = resolveAccountForSession(id);
    if ((prev?.id ?? null) === (next?.id ?? null)) continue;
    rehomeConversation(id, prev, next);
    affectedSessionIds.push(id);
  }

  return { affectedSessionIds };
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
