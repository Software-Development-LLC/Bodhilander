import { describe, expect, test } from 'bun:test';
import { isBenignXtermTeardownError } from '../error-filter';

describe('isBenignXtermTeardownError', () => {
  test('matches the exact xterm post-dispose handleResize error seen in the field', () => {
    // Verbatim from robert.main.log / brannon.main.log (multiple macOS users).
    const msg = "Uncaught TypeError: Cannot read properties of undefined (reading 'handleResize')";
    expect(isBenignXtermTeardownError(msg)).toBe(true);
  });

  test('matches the singular "property" phrasing too', () => {
    const msg = "Cannot read property of undefined (reading 'handleResize')";
    expect(isBenignXtermTeardownError(msg)).toBe(true);
  });

  test('matches a handleResize failure originating from xterm IdleTaskQueue via the stack', () => {
    const msg = 'TypeError: something about handleResize';
    const stack = 'at Array.<anonymous> (renderer.js:2:1)\n    at t.IdleTaskQueue._process (renderer.js:2:2)';
    expect(isBenignXtermTeardownError(msg, stack)).toBe(true);
  });

  test('does NOT match an unrelated undefined-property read', () => {
    // A real bug we must never swallow.
    const msg = "Cannot read properties of undefined (reading 'sessionId')";
    expect(isBenignXtermTeardownError(msg)).toBe(false);
  });

  test('does NOT match a plain handleResize mention with no xterm queue in the stack', () => {
    // e.g. one of our own components legitimately failing — keep surfacing it.
    const msg = 'handleResize is not a function';
    const stack = 'at Terminal (Terminal.tsx:144)';
    expect(isBenignXtermTeardownError(msg, stack)).toBe(false);
  });

  test('tolerates a non-string message', () => {
    expect(isBenignXtermTeardownError(undefined)).toBe(false);
    expect(isBenignXtermTeardownError({ some: 'event' })).toBe(false);
  });
});
