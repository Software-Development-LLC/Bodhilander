import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import log from 'electron-log';

/**
 * Where a Claude Code conversation lives on disk, and how to make it reachable
 * from a different account's config dir.
 *
 * Claude Code stores transcripts at <configDir>/projects/<cwd-slug>/<uuid>.jsonl
 * and reads that tree on --resume. Every account owns an isolated configDir
 * (BDHLNDR-31), so re-homing a session strands its transcript in the previous
 * account's tree unless it is carried across.
 *
 * This module knows only about files. It never reads the database and never
 * decides which account a session belongs to — callers hand it the dirs.
 */

/** Config dir a session runs under when no account resolves (pre-accounts behavior). */
export function legacyClaudeConfigDir(): string {
  return path.join(os.homedir(), '.claude');
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

export function isPathSafeConversationId(uuid: string): boolean {
  return PATH_SAFE_CONVERSATION_ID.test(uuid) && !uuid.includes('..');
}

/** @returns true when the transcript is readable from the target config dir. */
export function carryTranscript(uuid: string, fromDir: string, toDir: string): boolean {
  if (!isPathSafeConversationId(uuid)) {
    // Not a shape we'd ever have written — refuse to build a path from it.
    log.warn(`[Accounts] Refusing to carry conversation with unexpected id format: ${uuid}`);
    return false;
  }

  try {
    const source = findTranscript(fromDir, uuid);
    if (!source) return false;

    copyTranscriptInto(source, toDir, uuid);
    return true;
  } catch (err) {
    log.warn(`[Accounts] Could not carry conversation ${uuid} across accounts:`, err);
    return false;
  }
}

/**
 * Copy one transcript file into `toDir`, mirroring its project-slug dir. The
 * slug is derived from the session cwd, which neither a switch nor a respawn
 * changes, so reusing the source's slug is exact and needs no recomputation.
 *
 * `overwrite` is off by default because most callers only want to fill a gap.
 * Only the launch-time carry turns it on, and only once it has established by
 * mtime AND size that what is already there is an older state of the same
 * append-only file.
 *
 * Returns nothing: the only failure mode is a thrown fs error, and every
 * caller already sits inside a try/catch that decides what a failure means in
 * its own terms.
 */
function copyTranscriptInto(
  source: string,
  toDir: string,
  uuid: string,
  overwrite = false,
): void {
  const slug = path.basename(path.dirname(source));
  const targetDir = path.join(toDir, 'projects', slug);
  const target = path.join(targetDir, `${uuid}.jsonl`);
  if (!overwrite && fs.existsSync(target)) return;

  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
  log.info(`[Accounts] Carried conversation ${uuid} to ${targetDir}`);
}

/** mtime + size, or null when the file can't be stat'd (raced away, unreadable). */
function statOf(file: string): { mtimeMs: number; size: number } | null {
  try {
    const s = fs.statSync(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
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

export type TranscriptCarryResult = 'present' | 'carried' | 'missing';

/**
 * Make `uuid`'s transcript readable from `targetDir`, searching every config
 * dir the app knows about (#164).
 *
 * A switch-time copy is a point-in-time snapshot: a still-running Claude keeps
 * appending to the OLD account's tree, because its CLAUDE_CONFIG_DIR was baked
 * in at spawn. By the time the pty respawns the copy is stale, the --resume
 * fails, and the resume-failure fallback starts a fresh conversation with the
 * history orphaned. Doing the carry at LAUNCH instead closes that window: the
 * bytes are copied at the last possible moment before the CLI reads them.
 *
 * There is no "from" dir at launch — nothing records which account a previous
 * spawn used — so this searches. `legacy-claude-seed.ts` does the coarse eager
 * version of the same job for a brand-new account; this is the lazy one-file
 * version for a session that moved.
 *
 * Note what is deliberately NOT here: a "the target already has a copy, we're
 * done" short-circuit. Something already in the target dir is not evidence that
 * it is current. assignSessionAccount copies eagerly when the user clicks, and
 * a Claude that is still alive goes on appending to the OLD tree afterwards —
 * so on the restart that applies the switch, the file sitting in the target is
 * precisely the stale snapshot this function exists to get past. Treating
 * presence as sufficient reinstates #164's second symptom in full: the resume
 * succeeds, and every turn typed after the switch is silently gone. The target's
 * own copy therefore competes on mtime like any other candidate, and only wins
 * if it really is the newest.
 */
export function ensureTranscriptInConfigDir(
  uuid: string,
  targetDir: string,
  candidateDirs: string[],
): TranscriptCarryResult {
  if (!isPathSafeConversationId(uuid)) {
    log.warn(`[Accounts] Refusing to locate conversation with unexpected id format: ${uuid}`);
    return 'missing';
  }

  const existing = findTranscript(targetDir, uuid);
  const resolvedTarget = path.resolve(targetDir);

  // An earlier switch can leave the same uuid in several trees. The newest file
  // is the one Claude was actually appending to, and mtime makes the choice
  // deterministic rather than dependent on account ordering.
  let winner: string | null = null;
  let winnerStat: { mtimeMs: number; size: number } | null = null;
  for (const dir of candidateDirs) {
    if (path.resolve(dir) === resolvedTarget) continue;
    const found = findTranscript(dir, uuid);
    if (!found) continue;
    const stat = statOf(found); // Raced away between find and stat — unusable.
    if (stat === null || (winnerStat !== null && stat.mtimeMs <= winnerStat.mtimeMs)) continue;
    winnerStat = stat;
    winner = found;
  }

  if (!winner || !winnerStat) return existing ? 'present' : 'missing';

  if (existing) {
    const existingStat = statOf(existing);
    // copyFileSync stamps the destination with the time of the copy, so after a
    // carry the target outranks its own source until the CLI writes again —
    // which is what keeps the steady state down to no copy at all. An
    // unstattable target is left alone: overwriting the file the CLI is about
    // to read, on the strength of a stat that failed, is the worse gamble.
    if (existingStat === null || existingStat.mtimeMs >= winnerStat.mtimeMs) return 'present';

    // mtime alone must not authorise a destructive write. Nothing in this
    // pipeline preserves timestamps (copyFileSync here, fs.cp in
    // legacy-claude-seed), and these files sit in a home directory where a sync
    // client re-download, a backup restore or a stray touch rewrites mtime
    // without changing a byte — so "newer" can be a lie. Transcripts are
    // append-only within one conversation id, which makes size the check mtime
    // can't be: a shorter file is not a later state of the same conversation.
    // Losing a refresh costs one stale resume; losing the target costs the
    // user's history, with no error and no fallback because the resume works.
    if (winnerStat.size < existingStat.size) {
      log.warn(
        `[Accounts] Not overwriting ${existing} with ${winner}: the newer-looking file is ` +
        `smaller (${winnerStat.size} < ${existingStat.size} bytes), which an appended-to ` +
        `transcript cannot be. Keeping what is already staged.`
      );
      return 'present';
    }
  }

  try {
    copyTranscriptInto(winner, targetDir, uuid, existing !== null);
    return 'carried';
  } catch (err) {
    log.warn(`[Accounts] Could not carry conversation ${uuid} into ${targetDir}:`, err);
    // A failed refresh still leaves the older copy readable; only a target that
    // never had one is actually missing.
    return existing ? 'present' : 'missing';
  }
}
