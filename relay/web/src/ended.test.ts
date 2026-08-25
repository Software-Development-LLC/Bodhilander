/**
 * Which story an ended session tells. The rule under test: person-attributed
 * copy is reserved for reasons that arrived SEALED — anything derived from a
 * socket close lands on the neutral fallback, whatever the wire said.
 */
import { describe, expect, test } from 'bun:test';
import { CONNECTION_ENDED, ENDING_REASONS } from './connection';
import { endedCopy } from './ended';

describe('endedCopy', () => {
  test('a close-derived ending renders the neutral copy, not the attributed story', () => {
    const copy = endedCopy(CONNECTION_ENDED);
    expect(copy.title).toBe('This session ended');
    expect(copy.body).toBe('The connection to that machine closed. Ask whoever shared it if you still need access.');
    expect(copy.body).not.toContain('stopped sharing');
  });

  test('only the sealed revoked reason reaches the attributed story', () => {
    expect(endedCopy('revoked').body).toBe('The person who shared this session stopped sharing it.');
  });

  test('every sealed ending reason has its own words, none of them the fallback', () => {
    const titles = ENDING_REASONS.map((r) => endedCopy(r).title);
    expect(new Set(titles).size).toBe(ENDING_REASONS.length);
    for (const r of ENDING_REASONS) expect(endedCopy(r).title).not.toBe('This session ended');
  });

  test('an unknown reason is a statement of fact, never a guessed story', () => {
    expect(endedCopy('something_new')).toEqual(endedCopy(CONNECTION_ENDED));
    expect(endedCopy('')).toEqual(endedCopy(CONNECTION_ENDED));
  });
});
