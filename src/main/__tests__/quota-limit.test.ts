/**
 * Reading a quota rejection from the CLI's own record of it.
 *
 * The fixtures are real lines lifted from transcripts on a machine that hit
 * genuine limits, trimmed to the fields that matter. The negative cases matter
 * more than the positive one: the detector this replaced fired on a rendered
 * conversation ABOUT limits, and the whole point of moving to the transcript is
 * that such text cannot look like a rejection.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readQuotaLimit, describeRateLimitType } from '../quota-limit';

const UUID = 'c98f6d1d-8219-48db-a0eb-315d3729e3fb';
let dir: string;

/** A transcript in the layout the CLI writes: <cfg>/projects/<slug>/<uuid>.jsonl */
function writeTranscript(lines: string[]): string {
  const projects = path.join(dir, 'projects', '-Users-will-Work-Repos-Bodhilander');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, `${UUID}.jsonl`), lines.join('\n') + '\n');
  return dir;
}

const soon = () => Math.floor(Date.now() / 1000) + 4 * 3600;

const rejection = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  quotaLimits: {
    status: 'rejected', resetsAt: soon(), rateLimitType: 'seven_day',
    overageStatus: 'rejected', isUsingOverage: false,
  },
  timestamp: new Date().toISOString(),
  message: { role: 'assistant', content: "You've hit your weekly limit · resets Aug 26 at 2pm" },
  ...over,
});

/** An ordinary turn that talks about limits at length. */
const proseAboutLimits = JSON.stringify({
  type: 'assistant',
  timestamp: new Date().toISOString(),
  message: {
    role: 'assistant',
    content: "You've hit your weekly limit · resets Aug 26 at 2pm — that message is what "
      + 'the detector matches on. Claude usage limit reached. Your limit will reset at 7pm.',
  },
});

/** A different API error: same flag, no quota payload. */
const connectionError = JSON.stringify({
  type: 'assistant',
  isApiErrorMessage: true,
  timestamp: new Date().toISOString(),
  message: { role: 'assistant', content: 'API Error: Connection lost mid-response.' },
});

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readQuotaLimit', () => {
  test('reads the reset straight off the entry, not out of a sentence', () => {
    const at = soon();
    writeTranscript([rejection({ quotaLimits: { status: 'rejected', resetsAt: at, rateLimitType: 'five_hour' } })]);
    const hit = readQuotaLimit(dir, UUID);
    expect(hit).not.toBeNull();
    expect(hit!.resetAt.getTime()).toBe(at * 1000);
    expect(hit!.rateLimitType).toBe('five_hour');
  });

  /**
   * The failure that motivated the rewrite. This text matched every pattern the
   * previous detector had; here it is simply a turn the assistant took.
   */
  test('a conversation about usage limits is not a usage limit', () => {
    writeTranscript([proseAboutLimits, proseAboutLimits]);
    expect(readQuotaLimit(dir, UUID)).toBeNull();
  });

  test('another API error is not a quota rejection', () => {
    writeTranscript([connectionError]);
    expect(readQuotaLimit(dir, UUID)).toBeNull();
  });

  /** Warned is not refused — the same shape reports quota merely running low. */
  test('ignores a quota entry that was not rejected', () => {
    writeTranscript([rejection({
      quotaLimits: { status: 'allowed_warning', resetsAt: soon(), rateLimitType: 'seven_day' },
    })]);
    expect(readQuotaLimit(dir, UUID)).toBeNull();
  });

  /**
   * A transcript is append-only and replayed on resume, so yesterday's
   * rejection is still the last thing in the file after the account recovers.
   * Acting on it again would bench a healthy account — the loop that made the
   * previous bug self-sustaining.
   */
  test('ignores a rejection older than the caller cares about', () => {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    writeTranscript([rejection({ timestamp: old })]);
    expect(readQuotaLimit(dir, UUID, new Date(Date.now() - 60_000))).toBeNull();
    expect(readQuotaLimit(dir, UUID, new Date(Date.now() - 6 * 3600_000))).not.toBeNull();
  });

  test('ignores a rejection whose reset has already passed', () => {
    writeTranscript([rejection({
      quotaLimits: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) - 60, rateLimitType: 'five_hour' },
    })]);
    expect(readQuotaLimit(dir, UUID)).toBeNull();
  });

  test('takes the most recent rejection when there are several', () => {
    const later = soon() + 7200;
    writeTranscript([
      rejection({ quotaLimits: { status: 'rejected', resetsAt: soon(), rateLimitType: 'five_hour' } }),
      rejection({ quotaLimits: { status: 'rejected', resetsAt: later, rateLimitType: 'seven_day' } }),
    ]);
    expect(readQuotaLimit(dir, UUID)!.resetAt.getTime()).toBe(later * 1000);
  });

  /** A tail read starts mid-line, and a file being appended to can be caught
   *  mid-write. Neither is an error worth reporting. */
  test('survives a truncated or partial line', () => {
    writeTranscript(['{"type":"assis', rejection()]);
    expect(readQuotaLimit(dir, UUID)).not.toBeNull();
  });

  /**
   * The clock is a parameter, so the boundary is testable rather than inferred
   * from a window measured in hours.
   */
  test('judges expiry against the clock it is given', () => {
    const at = Math.floor(Date.now() / 1000) + 3600;
    writeTranscript([rejection({
      quotaLimits: { status: 'rejected', resetsAt: at, rateLimitType: 'five_hour' },
    })]);
    const justBefore = new Date((at - 1) * 1000);
    const justAfter = new Date((at + 1) * 1000);
    expect(readQuotaLimit(dir, UUID, undefined, justBefore)).not.toBeNull();
    expect(readQuotaLimit(dir, UUID, undefined, justAfter)).toBeNull();
  });

  test('is null when there is no transcript at all', () => {
    expect(readQuotaLimit(dir, UUID)).toBeNull();
  });

  test('refuses a conversation id that could escape the directory', () => {
    expect(readQuotaLimit(dir, '../../etc/passwd')).toBeNull();
  });
});

describe('describeRateLimitType', () => {
  test('names the window the way the CLI means it', () => {
    expect(describeRateLimitType('five_hour')).toBe('5-hour limit');
    expect(describeRateLimitType('seven_day')).toBe('weekly limit');
    expect(describeRateLimitType(null)).toBe('usage limit');
  });
});

describe('the real entries, verbatim', () => {
  /** Lifted from transcripts on a machine that hit genuine limits. */
  const real = fs.readFileSync(
    path.join(import.meta.dir, 'fixtures', 'transcript-entries.jsonl'), 'utf8',
  ).trim().split('\n');

  test('every captured rejection is recognised, and nothing else is', () => {
    const rejections = real.filter((l) => l.includes('"quotaLimits"'));
    expect(rejections.length).toBeGreaterThan(0);

    for (const line of rejections) {
      const entry = JSON.parse(line);
      // The captured resets are in the past by now; re-stamp to today so the
      // already-lifted guard doesn't mask what this is asserting.
      entry.quotaLimits.resetsAt = soon();
      entry.timestamp = new Date().toISOString();
      writeTranscript([JSON.stringify(entry)]);
      expect(readQuotaLimit(dir, UUID), line.slice(0, 60)).not.toBeNull();
    }

    for (const line of real.filter((l) => !l.includes('"quotaLimits"'))) {
      writeTranscript([line]);
      expect(readQuotaLimit(dir, UUID), line.slice(0, 60)).toBeNull();
    }
  });
});
