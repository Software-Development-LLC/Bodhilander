import * as fs from 'fs';
import log from 'electron-log';

import { findTranscript, isPathSafeConversationId } from './conversation-transcript';

/**
 * Reading "this account is out of quota" from the CLI's own record of it.
 *
 * The agent writes every turn to <configDir>/projects/<slug>/<uuid>.jsonl, and
 * a rejected request lands there as a structured entry rather than as prose:
 *
 *   { "type": "assistant", "isApiErrorMessage": true, "apiErrorStatus": 429,
 *     "quotaLimits": { "status": "rejected", "resetsAt": 1787767200,
 *                      "rateLimitType": "seven_day" } }
 *
 * That is a fact the CLI asserts about itself. It carries the exact reset as an
 * epoch, so nothing has to be parsed out of a sentence, and it cannot be
 * produced by rendering a conversation that happens to discuss usage limits —
 * which is the failure this replaced.
 */

/** How much of the tail to read. A rejected turn is the last thing written. */
const TAIL_BYTES = 64 * 1024;

/** How many trailing lines to inspect before giving up. */
const MAX_LINES = 200;

export interface QuotaLimitHit {
  /** When quota returns, from `resetsAt`. Exact, not parsed from prose. */
  resetAt: Date;
  /** The CLI's own name for the window, e.g. 'five_hour', 'seven_day'. */
  rateLimitType: string | null;
  /** The entry's own timestamp, or null when it carried none. */
  observedAt: Date | null;
}

/**
 * The most recent quota rejection in a conversation, or null.
 *
 * `since` exists because a transcript is append-only and replayed on resume: a
 * limit hit two hours ago is still the last thing in the file after the account
 * recovers, and acting on it again would bench a healthy account. Callers pass
 * the moment their process started.
 */
export function readQuotaLimit(
  configDir: string,
  conversationId: string,
  since?: Date,
): QuotaLimitHit | null {
  if (!isPathSafeConversationId(conversationId)) return null;

  let tail: string;
  try {
    const file = findTranscript(configDir, conversationId);
    if (!file) return null;

    const { size } = fs.statSync(file);
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, start);
      tail = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // A transcript that cannot be read is not evidence of a limit.
    log.warn(`[Quota] Could not read the transcript for ${conversationId}:`, err);
    return null;
  }

  const lines = tail.split('\n');
  const limit = Math.max(0, lines.length - MAX_LINES);
  for (let i = lines.length - 1; i >= limit; i--) {
    const hit = parseEntry(lines[i], since);
    if (hit) return hit;
  }
  return null;
}

/**
 * One transcript line, if it is a quota rejection.
 *
 * The first line of a tail read is usually a fragment, and a file being
 * appended to can be caught mid-write, so an unparseable line is ordinary and
 * silent. Only `status: 'rejected'` counts: the same shape reports quota that
 * is merely running low, and being warned is not being refused.
 */
function parseEntry(line: string, since?: Date): QuotaLimitHit | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('"quotaLimits"')) return null;

  let entry: any;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (entry?.isApiErrorMessage !== true) return null;
  const quota = entry.quotaLimits;
  if (quota?.status !== 'rejected' || typeof quota.resetsAt !== 'number') return null;

  const observedAt = typeof entry.timestamp === 'string' ? new Date(entry.timestamp) : null;
  if (since && observedAt && observedAt.getTime() < since.getTime()) return null;

  // resetsAt is seconds; a value already past describes a limit that has since
  // lifted, which is the resumed-transcript case and not something to act on.
  const resetAt = new Date(quota.resetsAt * 1000);
  if (resetAt.getTime() <= Date.now()) return null;

  return {
    resetAt,
    rateLimitType: typeof quota.rateLimitType === 'string' ? quota.rateLimitType : null,
    observedAt,
  };
}

/** How the CLI's window name reads in a sentence. */
export function describeRateLimitType(rateLimitType: string | null): string {
  switch (rateLimitType) {
    case 'five_hour': return '5-hour limit';
    case 'seven_day': return 'weekly limit';
    default: return 'usage limit';
  }
}
