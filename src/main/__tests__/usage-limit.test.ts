/**
 * Usage-limit detection (#207) — reading "this account is spent,
 * and here is when it comes back" out of terminal output.
 *
 * The two halves are tested for opposite failures. Detection is tested for
 * FALSE POSITIVES, because a wrong yes restarts live sessions and benches a
 * healthy account for hours. Reset parsing is tested for wrong ANSWERS,
 * because a reset time in the past is a cooldown that never applies and one
 * far in the future benches an account that came back at teatime.
 *
 * Run with: bun test src/main/__tests__/usage-limit.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { detectUsageLimit, parseResetAt } from '../usage-limit';

const NOW = new Date('2026-08-25T14:00:00');

describe('detectUsageLimit', () => {
  test('catches the wordings Claude Code actually prints', () => {
    const lines = [
      'Claude usage limit reached. Your limit will reset at 7pm (America/New_York)',
      "You've reached your usage limit.",
      // Typographic apostrophe — what a CLI rendering prose actually prints,
      // and the reason the pattern uses a character class rather than one quote.
      "You’ve reached your weekly limit.",
      'Weekly limit reached',
      '5-hour limit reached · resets 6pm',
      'Claude AI usage limit reached|1787000000',
    ];
    for (const line of lines) {
      expect(detectUsageLimit(line, undefined, NOW), line).not.toBeNull();
    }
  });

  test('ignores ordinary agent output', () => {
    const lines = [
      'Rate limiting the relay to 100 requests per minute',
      'The test asserts the limit is enforced',
      'reached the end of the file',
      '',
    ];
    for (const line of lines) {
      expect(detectUsageLimit(line, undefined, NOW), line).toBeNull();
    }
  });

  /**
   * The case that makes text-matching dangerous: an agent working on THIS
   * feature renders the trigger phrase into its own terminal. Nothing about
   * the channel distinguishes that from the CLI's own chrome, so the shape of
   * the line has to.
   */
  test('ignores the phrase when it is being quoted rather than announced', () => {
    const quoted = [
      "  /Claude (?:AI )?usage limit reached/i,",
      '  // Claude usage limit reached — the message we match on',
      '+ Claude usage limit reached',
      "42: 'Claude usage limit reached',",
      "const message = 'Claude usage limit reached';",
    ];
    for (const line of quoted) {
      expect(detectUsageLimit(line, undefined, NOW), line).toBeNull();
    }
  });

  test('reports the line it matched, so a log can be argued with', () => {
    const hit = detectUsageLimit(
      'thinking…\nClaude usage limit reached. Your limit will reset at 7pm\n',
      undefined,
      NOW,
    );
    expect(hit?.line).toBe('Claude usage limit reached. Your limit will reset at 7pm');
  });
});

describe('parseResetAt', () => {
  test('reads the epoch suffix headless mode prints', () => {
    const at = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
    const epoch = Math.floor(at.getTime() / 1000);
    expect(parseResetAt(`Claude AI usage limit reached|${epoch}`, NOW)?.getTime())
      .toBe(epoch * 1000);
  });

  test('reads a clock time later the same day', () => {
    const reset = parseResetAt('Your limit will reset at 7pm (America/New_York)', NOW);
    expect(reset?.getHours()).toBe(19);
    expect(reset?.getDate()).toBe(NOW.getDate());
  });

  /**
   * A limit hit at 11pm that "resets at 4am" resets tomorrow. Read as today it
   * would already be in the past — and an expired cooldown hands the spent
   * account straight back to the sessions that just bounced off it, which is
   * an immediate second failover rather than a recovery.
   */
  test('rolls a clock time that has already passed into tomorrow', () => {
    const lateNight = new Date('2026-08-25T23:10:00');
    const reset = parseResetAt('resets at 4am', lateNight);
    expect(reset?.getHours()).toBe(4);
    expect(reset?.getDate()).toBe(26);
  });

  test('reads a dated reset, for weekly limits days out', () => {
    const reset = parseResetAt('Weekly limit reached · resets Sep 2 at 9am', NOW);
    expect(reset?.getMonth()).toBe(8);
    expect(reset?.getDate()).toBe(2);
    expect(reset?.getHours()).toBe(9);
  });

  test('reads a duration', () => {
    const reset = parseResetAt('try again in 30 minutes', NOW);
    expect(reset?.getTime()).toBe(NOW.getTime() + 30 * 60 * 1000);
  });

  test('returns null rather than a guess when nothing says when', () => {
    expect(parseResetAt('Claude usage limit reached.', NOW)).toBeNull();
  });

  /**
   * Bare digits near the word "reset" are as often a token count as a time.
   * Null sends the caller to its default window, which is a known-safe answer;
   * a misread minute is a cooldown that expires immediately.
   */
  test('refuses a bare number with no am/pm and no minutes', () => {
    expect(parseResetAt('reset 5 times during this run', NOW)).toBeNull();
  });

  test('rejects a reset implausibly far out', () => {
    const epoch = Math.floor(NOW.getTime() / 1000) + 90 * 24 * 60 * 60;
    expect(parseResetAt(`usage limit reached|${epoch}`, NOW)).toBeNull();
  });
});
