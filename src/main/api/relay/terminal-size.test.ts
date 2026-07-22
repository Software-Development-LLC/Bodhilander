/**
 * Unit tests for sanitizeSize — the validation/clamping applied to a remote
 * (web/phone) client's terminal:resize before it reaches the native PTY resize.
 *
 * Run with: bun test src/main/api/relay/terminal-size.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { sanitizeSize, MAX_COLS, MAX_ROWS, MIN_DIM } from './terminal-size';

describe('sanitizeSize', () => {
  test('passes a normal size through, floored to integers', () => {
    expect(sanitizeSize(80, 24)).toEqual({ cols: 80, rows: 24 });
    expect(sanitizeSize(120.9, 40.2)).toEqual({ cols: 120, rows: 40 });
  });

  test('clamps up to the minimum', () => {
    expect(sanitizeSize(1, 1)).toEqual({ cols: MIN_DIM, rows: MIN_DIM });
    expect(sanitizeSize(0, 0)).toEqual({ cols: MIN_DIM, rows: MIN_DIM });
    expect(sanitizeSize(-50, -3)).toEqual({ cols: MIN_DIM, rows: MIN_DIM });
  });

  test('clamps down to the maximum (prevents an absurd native resize)', () => {
    expect(sanitizeSize(100000, 999999)).toEqual({ cols: MAX_COLS, rows: MAX_ROWS });
    expect(sanitizeSize(MAX_COLS + 1, MAX_ROWS + 1)).toEqual({ cols: MAX_COLS, rows: MAX_ROWS });
  });

  test('rejects non-finite values (NaN / Infinity)', () => {
    expect(sanitizeSize(NaN, 24)).toBeNull();
    expect(sanitizeSize(80, NaN)).toBeNull();
    expect(sanitizeSize(Infinity, 24)).toBeNull();
    expect(sanitizeSize(80, -Infinity)).toBeNull();
  });

  test('rejects non-number shapes (missing/wrong-typed frame fields)', () => {
    expect(sanitizeSize(undefined, 24)).toBeNull();
    expect(sanitizeSize(80, undefined)).toBeNull();
    expect(sanitizeSize('80', '24')).toBeNull();
    expect(sanitizeSize(null, null)).toBeNull();
    expect(sanitizeSize({ cols: 80 }, 24)).toBeNull();
  });
});
