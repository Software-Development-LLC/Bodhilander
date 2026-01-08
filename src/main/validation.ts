/**
 * Input Validation Utilities
 *
 * Provides validation functions for API and IPC inputs.
 */

// UUID v4 pattern
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate that a string is a valid UUID v4
 */
export function isValidUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * Validate string with max length
 */
export function isValidString(value: unknown, maxLength: number = 10000): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

/**
 * Validate non-empty string with max length
 */
export function isNonEmptyString(value: unknown, maxLength: number = 10000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * Validate that a value is a positive integer
 */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Validate that a value is a non-negative integer
 */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate a file path (basic sanity check - no null bytes, reasonable length)
 */
export function isValidFilePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 4096) return false;
  if (value.includes('\0')) return false; // No null bytes
  return true;
}

/**
 * Validate session state
 */
export function isValidSessionState(value: unknown): value is string {
  const validStates = ['idle', 'working', 'waiting', 'error', 'stopped'];
  return typeof value === 'string' && validStates.includes(value);
}

/**
 * Validate group color (hex color)
 */
export function isValidColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^#[0-9a-fA-F]{6}$/.test(value);
}
