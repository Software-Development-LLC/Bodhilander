/**
 * Validation for terminal sizes arriving from a remote (web/phone) client before
 * they reach the native PTY resize. Kept dependency-free so it's trivially
 * unit-testable in isolation from the E2E tunnel.
 */

/** Upper bounds for a remote-supplied terminal size — generous but sane. */
export const MAX_COLS = 1000;
export const MAX_ROWS = 1000;
export const MIN_DIM = 2;

/**
 * Validate & clamp a terminal size from an (untrusted-shaped) client frame.
 * Rejects non-numbers and non-finite values (NaN/Infinity), floors to integers,
 * and clamps into [MIN_DIM, MAX_*]. Returns null when the input can't be valid.
 */
export function sanitizeSize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  if (typeof cols !== 'number' || typeof rows !== 'number') return null;
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return {
    cols: Math.min(MAX_COLS, Math.max(MIN_DIM, Math.floor(cols))),
    rows: Math.min(MAX_ROWS, Math.max(MIN_DIM, Math.floor(rows))),
  };
}
