import { describe, expect, test } from 'bun:test';
import { CONTEXT_LIMIT_TOKENS, freshReason, freshSessionInput, lostSessionInput, sessionLost } from '../sessions';

const NOW = Date.parse('2026-11-27T15:00:00Z');
const thread = (over = {}) => ({ sessionId: 's1', contextTokens: 1000, lastRunAt: NOW - 60_000, tainted: false, moved: false, otherAccount: false, ...over });

describe('fresh sessions', () => {
  test('a thread with no session has nothing to refresh', () => {
    expect(freshReason(thread({ sessionId: null, tainted: true }), NOW, null)).toBeNull();
  });

  test('size, a new day in the owner timezone, a move and taint each start fresh', () => {
    expect(freshReason(thread(), NOW, null)).toBeNull();
    expect(freshReason(thread({ contextTokens: CONTEXT_LIMIT_TOKENS }), NOW, null)).toBeNull();
    expect(freshReason(thread({ contextTokens: CONTEXT_LIMIT_TOKENS + 1 }), NOW, null)).toBe('size');
    const late = Date.parse('2026-11-27T04:30:00Z');
    expect(freshReason(thread({ lastRunAt: late }), Date.parse('2026-11-27T05:30:00Z'), 'America/New_York')).toBe('new-day');
    expect(freshReason(thread({ lastRunAt: late }), Date.parse('2026-11-27T05:30:00Z'), 'UTC')).toBeNull();
    expect(freshReason(thread({ moved: true }), NOW, null)).toBe('moved');
    expect(freshReason(thread({ tainted: true, moved: true }), NOW, null)).toBe('tainted');
  });

  test("a session made under another account is never resumed, and says why", () => {
    expect(freshReason(thread({ otherAccount: true }), NOW, null)).toBe('other-account');
    expect(freshReason(thread({ otherAccount: true, tainted: true }), NOW, null)).toBe('tainted');
    expect(freshSessionInput('other-account', [], 'hi').startsWith("This assistant's account changed")).toBe(true);
  });

  test('a fresh input carries the last four turns, clipped, then the message', () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({ input: `m${i}`, reply: i === 5 ? 'x'.repeat(700) : `r${i}` }));
    const text = freshSessionInput('size', turns, 'new');
    expect(text.startsWith('This thread grew long')).toBe(true);
    expect(text).not.toContain('m1');
    expect(text).toContain('Message: m2');
    expect(text).toContain(`You replied: ${'x'.repeat(599)}…`);
    expect(text.endsWith('The new message:\n\nnew')).toBe(true);
  });

  test('a lost session with no turns is just the message', () => {
    expect(lostSessionInput([], 'hi')).toBe('hi');
    expect(lostSessionInput([{ input: 'a', reply: null }], 'hi')).toContain('could not be found');
    expect(sessionLost('Error: No conversation found with session ID: s1')).toBe(true);
    expect(sessionLost('other')).toBe(false);
  });
});
