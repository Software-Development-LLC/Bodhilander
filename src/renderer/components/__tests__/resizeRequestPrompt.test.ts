/**
 * The owner's prompt for a guest's "Fit to my screen" request: when it is
 * worth interrupting them, and what the question actually claims.
 */
import { describe, expect, test } from 'bun:test';
import { RelayResizeRequest } from '../../../shared/types';
import {
  KEEP_MY_SIZE,
  RESIZE_ONCE,
  resizeRequestCopy,
  shouldPrompt,
  whoIsAsking,
} from '../resizeRequestPrompt';

const request = (over: Partial<RelayResizeRequest> = {}): RelayResizeRequest => ({
  sessionId: 's1',
  cols: 80,
  rows: 24,
  login: 'dana-k',
  displayName: 'Dana K',
  ...over,
});

describe('shouldPrompt', () => {
  test('a request for this session, at a different size, asks', () => {
    expect(shouldPrompt(request(), 's1', { cols: 164, rows: 48 })).toBe(true);
  });

  test('a request for another session belongs to another terminal', () => {
    expect(shouldPrompt(request({ sessionId: 's2' }), 's1', { cols: 164, rows: 48 })).toBe(false);
  });

  test('a request for the size we are already at asks for nothing', () => {
    // Interrupting the owner to offer them a no-op spends attention for
    // nothing, and makes the next real prompt easier to dismiss unread.
    expect(shouldPrompt(request(), 's1', { cols: 80, rows: 24 })).toBe(false);
  });

  test('one differing dimension is still a real request', () => {
    expect(shouldPrompt(request(), 's1', { cols: 80, rows: 48 })).toBe(true);
    expect(shouldPrompt(request(), 's1', { cols: 100, rows: 24 })).toBe(true);
  });

  test('before this window has measured itself, the ask still stands', () => {
    expect(shouldPrompt(request(), 's1', null)).toBe(true);
  });

  test('a size that could not fit anything is refused rather than rendered', () => {
    expect(shouldPrompt(request({ cols: 0 }), 's1', { cols: 164, rows: 48 })).toBe(false);
    expect(shouldPrompt(request({ rows: 0 }), 's1', { cols: 164, rows: 48 })).toBe(false);
  });
});

describe('whoIsAsking', () => {
  test('the immutable handle wins over a display name anyone can change', () => {
    expect(whoIsAsking(request())).toBe('@dana-k');
  });

  test('a display name is used only when there is no handle', () => {
    expect(whoIsAsking(request({ login: null }))).toBe('Dana K');
  });

  test('with neither, the prompt still says a person asked', () => {
    expect(whoIsAsking(request({ login: null, displayName: null }))).toBe('Someone watching');
  });
});

describe('resizeRequestCopy', () => {
  test('names the requested size and the one it would replace', () => {
    expect(resizeRequestCopy(request(), { cols: 164, rows: 48 })).toBe(
      '@dana-k asked to fit this session to their screen (80×24) — yours is 164×48.',
    );
  });

  test('claims no current size it does not know', () => {
    const copy = resizeRequestCopy(request(), null);
    expect(copy).toBe('@dana-k asked to fit this session to their screen (80×24).');
    expect(copy).not.toContain('yours');
  });

  test('the answers are one-tap and say what they do', () => {
    // "Resize once" is the whole promise: the next fit of this window takes
    // the size back, and the button must not imply otherwise.
    expect(RESIZE_ONCE).toBe('Resize once');
    expect(KEEP_MY_SIZE).toBe('Keep my size');
  });
});
