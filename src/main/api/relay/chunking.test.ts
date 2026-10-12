/**
 * Unit tests for chunkText — the split applied to scrollback replay so a long
 * history can't be sealed into one multi-megabyte frame.
 *
 * Run with: bun test src/main/api/relay/chunking.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { chunkText, MAX_CHUNK_CHARS } from './chunking';

describe('chunkText', () => {
  test('an empty history produces no frames at all', () => {
    expect(chunkText('')).toEqual([]);
  });

  test('passes a short history through as a single chunk', () => {
    expect(chunkText('hello world', 64)).toEqual(['hello world']);
  });

  test('splits at the limit and loses nothing', () => {
    const text = 'abcdefghij'.repeat(10); // 100 chars
    const chunks = chunkText(text, 30);

    expect(chunks).toHaveLength(4);
    expect(chunks.every((c) => c.length <= 30)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  test('an exact multiple of the limit does not emit a trailing empty chunk', () => {
    const chunks = chunkText('x'.repeat(60), 30);

    expect(chunks).toHaveLength(2);
    expect(chunks.join('')).toBe('x'.repeat(60));
  });

  test('never splits a surrogate pair', () => {
    // '😀' is two UTF-16 units, so a naive slice at an odd boundary would cut
    // it in half and produce a lone surrogate that survives sealing and only
    // corrupts at the renderer.
    const text = '😀'.repeat(10);
    const chunks = chunkText(text, 5);

    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/); // no trailing high surrogate
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/); // no leading low surrogate
    }
  });

  test('handles a realistic scrollback above the default limit', () => {
    const text = 'line of terminal output\n'.repeat(20_000);
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});
