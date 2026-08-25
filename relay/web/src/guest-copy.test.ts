/**
 * Guest voice. Two rules are pinned here: the copy names the person who
 * shared, and the only capability vocabulary that reaches a reader is one of
 * the two role words.
 */
import { describe, expect, test } from 'bun:test';
import {
  connectionProblemCopy,
  fitAskedCopy,
  guestSubtitle,
  offlineCopy,
  ownerPossessive,
  waitingCopy,
  wideBannerCopy,
} from './guest-copy';

describe('ownerPossessive', () => {
  test('names the owner when we know them', () => {
    expect(ownerPossessive('Will')).toBe("Will's");
  });

  test('degrades to a pronoun rather than an empty possessive', () => {
    expect(ownerPossessive(null)).toBe('their');
    expect(ownerPossessive(undefined)).toBe('their');
    expect(ownerPossessive('')).toBe('their');
  });
});

describe('offlineCopy', () => {
  test("the guest is told whose machine it is, and that we'll keep asking", () => {
    expect(offlineCopy(true, 'Will')).toBe(
      "Will's machine is offline right now. We'll ask again as soon as it's back.",
    );
  });

  test('an owner keeps owner vocabulary — it is their machine', () => {
    expect(offlineCopy(false, null)).toBe("This machine is offline. It'll appear here when it reconnects.");
  });

  test('an unknown owner still reads as somebody else\'s machine — and as a sentence', () => {
    // display_name is nullable on the relay, so this is a real state, not a
    // defensive branch: it must not open a sentence in lower case.
    expect(offlineCopy(true, null)).toBe(
      "Their machine is offline right now. We'll ask again as soon as it's back.",
    );
  });
});

describe('connectionProblemCopy', () => {
  test('a specific reason is never replaced by a friendlier vague one', () => {
    const detail = 'This machine failed identity verification. The connection may be tampered with.';
    expect(connectionProblemCopy(true, 'Will', detail)).toBe(detail);
    expect(connectionProblemCopy(false, null, detail)).toBe(detail);
  });

  test('without a reason, each side gets its own voice', () => {
    expect(connectionProblemCopy(true, 'Will')).toBe("Can't reach Will's machine right now.");
    expect(connectionProblemCopy(false, null)).toBe('Connection problem.');
  });
});

describe('waitingCopy', () => {
  test('names the person being waited on', () => {
    const copy = waitingCopy('Will');
    expect(copy.title).toBe('Waiting for Will to let you in…');
    expect(copy.body).toContain('Keep this page open');
  });

  test('says the same thing without inventing a name', () => {
    const copy = waitingCopy(null);
    expect(copy.title).toBe('Waiting to be let in…');
    expect(copy.body).toContain("it'll update on its own");
    expect(copy.body).not.toContain('null');
  });
});

describe('guestSubtitle', () => {
  test('shared by a person, and what you can do, in the two words', () => {
    expect(guestSubtitle('Will', 'viewer')).toBe('Shared by Will · watching');
    expect(guestSubtitle('Will', 'operator')).toBe('Shared by Will · watching and typing');
  });

  test('an unknown role reads as the smaller capability, never as a promise', () => {
    expect(guestSubtitle('Will', null)).toBe('Shared by Will · watching');
    expect(guestSubtitle('Will', 'admin')).toBe('Shared by Will · watching');
  });

  test('server role names never reach the reader', () => {
    for (const role of ['viewer', 'operator', 'admin', null]) {
      const line = guestSubtitle('Will', role);
      expect(line).not.toContain('viewer');
      expect(line).not.toContain('operator');
      expect(line).not.toContain('grant');
    }
  });

  test('an unknown owner still says the session came from someone', () => {
    expect(guestSubtitle(null, 'viewer')).toBe('Shared with you · watching');
  });
});

describe('wideBannerCopy', () => {
  test('says whose screen it is sized for, and what to do about it', () => {
    expect(wideBannerCopy('Will', 164)).toBe("Sized for Will's screen (164 columns). Drag sideways to read.");
    expect(wideBannerCopy(null, 100)).toBe('Sized for their screen (100 columns). Drag sideways to read.');
  });
});

describe('fitAskedCopy', () => {
  test('promises nothing — the owner may say no, and then nothing changes', () => {
    expect(fitAskedCopy('Will')).toBe(
      'Asked Will to resize. Nothing changes unless they say yes — you can keep reading meanwhile.',
    );
    expect(fitAskedCopy(null)).toContain('Asked them to resize.');
  });
});
