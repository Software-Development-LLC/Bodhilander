/**
 * Reading "this account is out of quota" out of an agent CLI's terminal output.
 *
 * There is no structured channel for this. The CLI announces a usage limit by
 * printing it, so the pty output scanner is where it has to be caught — the
 * same place `waitingPatterns` already reads the TUI. This module owns the two
 * halves of that: which lines mean "limited", and when the limit lifts.
 *
 * It knows nothing about accounts, sessions or the database. It turns text
 * into a verdict; account-failover.ts decides what the verdict costs.
 */

/**
 * Lines that mean the account behind the CLI has run out of quota.
 *
 * Kept narrow on purpose. A false positive here does not produce a harmless
 * extra log line — it restarts a live session under a different account and
 * marks a healthy account as limited for hours. "limit" and "rate" on their
 * own appear constantly in ordinary agent output and are deliberately absent.
 */
export const CLAUDE_USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /Claude (?:AI )?usage limit reached/i,
  /(?:You(?:'|’)ve|You have) reached your (?:usage|weekly|5-hour) limit/i,
  /(?:usage|weekly|5-hour|session) limit reached/i,
  /Your limit will reset at/i,
] as const;

/**
 * Markers that say the matched line is the CLI *quoting* a limit message
 * rather than emitting one.
 *
 * This is not hypothetical: an agent reading this very file, a grep hit, a
 * diff, or a conversation about rate limits all put the trigger phrase on
 * screen inside a session that is running perfectly well. Terminal output is
 * an open channel — anything the user or the agent renders arrives here
 * indistinguishable from the CLI's own chrome — so the check is for the shape
 * of quoted code and prose, not for a trusted source.
 *
 * It cannot be complete, and does not have to be: everything it misses is
 * still bounded downstream, where failover refuses to fire twice for the same
 * account inside a short window and never targets an account already cooling.
 */
const QUOTED_MARKERS: readonly RegExp[] = [
  /\/[gimsuy]*,\s*$/,        // trailing regex-literal flags, e.g. `/i,`
  /^\s*[-+]/,                 // diff line
  /^\s*(?:\/\/|\*|#)/,        // comment
  /[`'"]\s*[:,]/,             // a quoted string used as a value
  /=>|===|\bfunction\b|\bconst\b|\bexport\b/,
  /^\s*\d+[:|]/,              // grep -n / line-numbered file output
] as const;

/** The line `index` falls on, without scanning the whole buffer. */
function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end);
}

/**
 * Longest a cooldown may run. A parsed reset time further out than this is a
 * misread, not a week-long lockout, and is dropped in favour of the caller's
 * default window.
 */
const MAX_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000;

export interface UsageLimitHit {
  /** The line that announced it, for logs and the notification body. */
  line: string;
  /** When the CLI said quota returns, or null when it did not say. */
  resetAt: Date | null;
}

/**
 * Scan recent output for a usage-limit announcement.
 *
 * `patterns` comes from the provider so a non-Claude CLI can bring its own
 * wording; the quoting guard and the reset parsing are shared.
 */
export function detectUsageLimit(
  text: string,
  patterns: readonly RegExp[] = CLAUDE_USAGE_LIMIT_PATTERNS,
  now: Date = new Date(),
): UsageLimitHit | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;

    const line = lineAround(text, match.index).trim();
    if (QUOTED_MARKERS.some(marker => marker.test(line))) continue;

    return { line, resetAt: parseResetAt(text.slice(match.index), now) };
  }
  return null;
}

/**
 * When the quota comes back, read out of the announcement itself.
 *
 * Four shapes, in descending order of how much they actually pin down:
 *   |1763000000            headless mode's epoch suffix — unambiguous
 *   resets Nov 12 at 9am   weekly limits, which can be days out
 *   reset at 3:30pm        a clock time with no date
 *   resets in 42 minutes   a duration
 *
 * A bare clock time is the common case and the ambiguous one: it carries no
 * date, so it is read as the NEXT occurrence of that time. Reading it as
 * today's would put the reset in the past for any limit hit in the evening,
 * and a cooldown that has already expired is no cooldown at all — the account
 * would be handed straight back to the sessions that just bounced off it.
 */
export function parseResetAt(text: string, now: Date = new Date()): Date | null {
  const candidate = parseEpochSuffix(text)
    ?? parseRelative(text, now)
    ?? parseDatedClock(text, now)
    ?? parseClock(text, now);

  if (!candidate) return null;

  // A reset that is already past, or implausibly far out, tells us nothing
  // useful; the caller's default window is the better answer.
  const delta = candidate.getTime() - now.getTime();
  if (delta <= 0 || delta > MAX_COOLDOWN_MS) return null;
  return candidate;
}

/** `Claude AI usage limit reached|1763000000` — seconds since the epoch. */
function parseEpochSuffix(text: string): Date | null {
  const match = /\|\s*(\d{10,13})\b/.exec(text);
  if (!match) return null;
  const raw = Number(match[1]);
  // 13 digits is already milliseconds; 10 is seconds.
  return new Date(match[1].length >= 13 ? raw : raw * 1000);
}

/** `resets in 42 minutes` / `try again in 2 hours`. */
function parseRelative(text: string, now: Date): Date | null {
  const match = /\bin\s+(\d+)\s*(second|minute|hour|day)s?\b/i.exec(text);
  if (!match) return null;
  const unit = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }[
    match[2].toLowerCase() as 'second' | 'minute' | 'hour' | 'day'
  ];
  return new Date(now.getTime() + Number(match[1]) * unit);
}

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

/** `resets Nov 12 at 9am` — a weekly limit, which needs the date to be right. */
function parseDatedClock(text: string, now: Date): Date | null {
  const match = new RegExp(
    String.raw`\b(${MONTHS.join('|')})[a-z]*\.?\s+(\d{1,2})\b(?:[^\n]{0,12}?(\d{1,2})(?::(\d{2}))?\s*(am|pm))?`,
    'i',
  ).exec(text);
  if (!match) return null;

  const month = MONTHS.indexOf(match[1].toLowerCase());
  const day = Number(match[2]);
  const { hours, minutes } = match[3]
    ? clockToHours(Number(match[3]), Number(match[4] ?? 0), match[5])
    : { hours: 0, minutes: 0 };

  // No year in the text. Use this one, and roll forward when that lands in the
  // past — a limit announced on Dec 30 that resets "Jan 2" means next year.
  const candidate = new Date(now.getFullYear(), month, day, hours, minutes, 0, 0);
  if (candidate.getTime() < now.getTime()) candidate.setFullYear(now.getFullYear() + 1);
  return candidate;
}

/** `resets at 3pm` / `reset at 10:30 PM` — next occurrence of that clock time. */
function parseClock(text: string, now: Date): Date | null {
  const match = /\b(?:reset|resets|resetting)\b[^\n]{0,20}?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!match) return null;

  // Bare digits with no am/pm are as likely to be a token count as a time.
  if (!match[3] && !match[2]) return null;

  const { hours, minutes } = clockToHours(Number(match[1]), Number(match[2] ?? 0), match[3]);
  if (hours > 23 || minutes > 59) return null;

  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function clockToHours(hour: number, minutes: number, meridiem?: string): { hours: number; minutes: number } {
  let hours = hour;
  const suffix = meridiem?.toLowerCase();
  if (suffix === 'pm' && hours < 12) hours += 12;
  if (suffix === 'am' && hours === 12) hours = 0;
  return { hours, minutes };
}
