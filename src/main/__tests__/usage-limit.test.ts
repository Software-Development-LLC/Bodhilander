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

  /**
   * The message a real weekly limit produced, verbatim, on 2026-08-25.
   *
   * The first version of these patterns did not match it. Every one of them
   * required the word "reached"; this says "hit", and joins the reset to the
   * limit with a bullet rather than a sentence, so neither "limit reached" nor
   * "will reset at" appears anywhere in it. Detection returned null and
   * failover silently never fired — the exact failure the feature exists to
   * prevent, arrived at by guessing the wording instead of observing it.
   *
   * It is pinned here as a literal because a paraphrase would not have caught
   * it: the difference between the guess and the truth was one verb.
   */
  test('catches the weekly-limit message an actual run produced', () => {
    const real = "You've hit your weekly limit · resets Aug 26 at 2pm (America/New_York)";
    const hit = detectUsageLimit(real, undefined, NOW);
    expect(hit).not.toBeNull();
    expect(hit!.resetAt?.getMonth()).toBe(7); // August
    expect(hit!.resetAt?.getDate()).toBe(26);
    expect(hit!.resetAt?.getHours()).toBe(14);
  });

  test('catches it wrapped in the error line an agent reports it through', () => {
    const wrapped = "Agent terminated early due to an API error: "
      + "You've hit your weekly limit · resets Aug 26 at 2pm (America/New_York)";
    expect(detectUsageLimit(wrapped, undefined, NOW)).not.toBeNull();
  });

  test('catches a limit with no qualifier and a status-line reset', () => {
    expect(detectUsageLimit("You've hit your limit", undefined, NOW)).not.toBeNull();
    expect(detectUsageLimit('5-hour limit · resets 9pm', undefined, NOW)).not.toBeNull();
  });

  /**
   * The accepted false-positive surface, made visible.
   *
   * "You've hit your <something> limit" is a sentence other services say too,
   * and this terminal shows their errors as readily as Claude's. A false
   * positive is not inert — it restarts live sessions and benches a healthy
   * account for hours — so the qualifier is an enumerated set of the windows
   * Anthropic actually meters on, not any word at all.
   */
  test('does not treat another service\'s limit as a Claude usage limit', () => {
    const foreign = [
      "You've hit your credit limit",
      "You've reached your spending limit",
      "You have reached your character limit",
      "You've hit your context limit",
    ];
    for (const line of foreign) {
      expect(detectUsageLimit(line, undefined, NOW), line).toBeNull();
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
      // The new "hit your <x> limit" and bullet-form patterns, quoted.
      "  /(?:usage|weekly|5-hour|session) limit\\b[^\\n]{0,24}?\\bresets?\\b/i,",
      "  // You've hit your weekly limit — the message we match on",
      "+ You've hit your weekly limit",
      "const msg = \"You've hit your weekly limit\";",
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

/**
 * Repaint blobs captured from a real machine while detection was misfiring.
 *
 * An agent TUI positions with escape codes rather than newlines, so once those
 * are stripped a whole screen arrives as one unbroken run — which is why the
 * words are run together. Two of these contain no limit message at all; they
 * matched on prose ABOUT limits, which is the text most likely to contain the
 * trigger words.
 *
 * Kept verbatim. A tidied fixture would not reproduce the bug, because what
 * made it possible was the shape of the input, not its content.
 */
const REPAINT_BLOBS: readonly string[] = [
    "h I'd failed to crack:thePRisCONFLICTING.GitHubrunspull_requestworkflowsagainstrefs/pull/205/merge,andaconflictingPRhasnosuchref",
    "\u2014sopushesproducednothing,whileGitGuardian(whichrunsonthecommititself)reportednormally.developmentmovedto24bd702elevenminutesbeforethePRopened.Onemerge",
    "clearsbothproblems.",
    "Sotheownernowhastwoblockersbatched:",
    "1.The relink refetch\u2014theoperator-pathbugabove.",
    "2.Merge development\u2014threerealconflicts,plusfourfileseditedonbothsidesthatauto-mergebuthaveneverbeenexercisedcombined.Everygreensofarwasmeasuredonatree",
  ];

describe('screen repaint is not a message', () => {
  test('refuses every blob that marked a healthy account limited', () => {
    for (const blob of REPAINT_BLOBS) {
      expect(detectUsageLimit(blob, undefined, NOW), blob.slice(0, 70)).toBeNull();
    }
  });

  /**
   * The guard has to be about SHAPE, not about these particular strings. A
   * genuine announcement is still caught when it arrives as its own line.
   */
  test('still catches the real message on a line of its own', () => {
    const real = "You've hit your weekly limit \u00b7 resets Aug 26 at 2pm (America/New_York)";
    expect(detectUsageLimit(real, undefined, NOW)).not.toBeNull();
    expect(detectUsageLimit('agent output\n' + real + '\nmore output', undefined, NOW)).not.toBeNull();
  });

  test('refuses it once it is buried in a screen-sized run', () => {
    const real = "You've hit your weekly limit \u00b7 resets Aug 26 at 2pm";
    const buried = 'x'.repeat(400) + real + 'y'.repeat(400);
    expect(detectUsageLimit(buried, undefined, NOW)).toBeNull();
  });
});
