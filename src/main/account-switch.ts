import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import log from 'electron-log';

import { AccountSwitchResult, ClaudeAccount } from '../shared/types';
import { getDatabase } from './database';
import { resolveAccountForSession } from './account-resolver';
import * as groupsRepo from './repositories/groups';
import * as sessionsRepo from './repositories/sessions';

/**
 * Reassigning a session's Claude account (BDHLNDR-31) is more than a column
 * write: the account only reaches the CLI as CLAUDE_CONFIG_DIR, and that env
 * var is baked into the pty at spawn time (see PtyManager.buildAgentSpawn). A
 * live session therefore keeps billing the old account until its pty respawns.
 *
 * This module owns the two follow-ups the column write can't do on its own:
 *   1. carry the in-flight conversation transcript into the new account's
 *      config dir, so the respawn can still `--resume` it, and
 *   2. report which sessions changed effective account, so the renderer knows
 *      which ptys to restart.
 */

/** Config dir a session runs under when no account resolves (pre-accounts behavior). */
function configDirOf(account: ClaudeAccount | null): string {
  return account?.configDir ?? path.join(os.homedir(), '.claude');
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
 * Keep a session's conversation alive across an account change.
 *
 * Claude Code stores transcripts under <configDir>/projects/<cwd-slug>/<uuid>.jsonl
 * and reads that tree on `--resume`. After a switch the stored UUID points into
 * the *old* account's tree, so the next launch would fail to resume and land in
 * PtyManager's resume-failure fallback — a fresh conversation, history orphaned.
 * Copying the transcript across preserves continuity, which is the whole point
 * of switching mid-task when an account runs out.
 *
 * When the transcript can't be carried over (missing, unreadable, copy failed)
 * we drop the stored UUID instead, so the respawn starts a clean conversation
 * rather than burning a doomed `--resume` attempt.
 */
function rehomeConversation(
  sessionId: string,
  from: ClaudeAccount | null,
  to: ClaudeAccount | null,
): void {
  const uuid = sessionsRepo.getClaudeSessionId(sessionId);
  if (!uuid) return; // Never launched — nothing to carry.

  if (carryTranscript(uuid, configDirOf(from), configDirOf(to))) return;

  try {
    sessionsRepo.clearClaudeSessionId(sessionId);
  } catch (err) {
    log.error(`[Accounts] Failed to clear claude_session_id for ${sessionId}:`, err);
  }
}

/**
 * A conversation id we're willing to interpolate into a filesystem path.
 *
 * Today these are always crypto.randomUUID() output written by this app, so
 * nothing in the current flow can produce a hostile value — but the id reaches
 * us from a database column and is used to build a path, and that pairing
 * shouldn't rest on an assumption about the writer. Rejecting separators and
 * traversal makes the containment local and checkable.
 */
const PATH_SAFE_CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isPathSafeConversationId(uuid: string): boolean {
  return PATH_SAFE_CONVERSATION_ID.test(uuid) && !uuid.includes('..');
}

/** @returns true when the transcript is readable from the target config dir. */
function carryTranscript(uuid: string, fromDir: string, toDir: string): boolean {
  if (!isPathSafeConversationId(uuid)) {
    // Not a shape we'd ever have written — refuse to build a path from it and
    // let the caller drop the id, which restarts on a fresh conversation.
    log.warn(`[Accounts] Refusing to carry conversation with unexpected id format: ${uuid}`);
    return false;
  }

  try {
    const source = findTranscript(fromDir, uuid);
    if (!source) return false;

    // Mirror the source's project-slug dir; the slug is derived from the
    // session cwd, which the switch doesn't change.
    const slug = path.basename(path.dirname(source));
    const targetDir = path.join(toDir, 'projects', slug);
    const target = path.join(targetDir, `${uuid}.jsonl`);
    if (fs.existsSync(target)) return true;

    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(source, target);
    log.info(`[Accounts] Carried conversation ${uuid} to ${targetDir}`);
    return true;
  } catch (err) {
    log.warn(`[Accounts] Could not carry conversation ${uuid} across accounts:`, err);
    return false;
  }
}

/** Locate <configDir>/projects/<any-slug>/<uuid>.jsonl without recomputing the slug. */
function findTranscript(configDir: string, uuid: string): string | null {
  const projects = path.join(configDir, 'projects');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true });
  } catch (err) {
    // A missing projects/ dir is the ordinary "no transcripts yet" case and
    // stays quiet. Anything else — permissions, I/O — is an environment
    // problem, and silently reading it as "nothing to carry" would present a
    // broken machine as a routine fresh conversation.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`[Accounts] Could not read ${projects} while carrying a conversation:`, err);
    }
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projects, entry.name, `${uuid}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
