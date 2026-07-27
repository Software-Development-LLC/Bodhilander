/**
 * Keyboard-shortcut target guard tests (#141).
 *
 * Bare navigation keys must not fire while the user types in a text field —
 * the sidebar's collapse/expand handlers persist `collapsed` to the database.
 *
 * Run with: bun test src/renderer/hooks/__tests__
 */
import { describe, expect, test } from 'bun:test';
import { isEditableTarget } from '../useKeyboardShortcuts';

function el(tagName: string, isContentEditable = false) {
  return { tagName, isContentEditable } as unknown as EventTarget;
}

describe('isEditableTarget', () => {
  test('text inputs are editable', () => {
    expect(isEditableTarget(el('INPUT'))).toBe(true);
  });

  test('textareas are editable (covers the terminal hidden textarea)', () => {
    expect(isEditableTarget(el('TEXTAREA'))).toBe(true);
  });

  test('selects are editable', () => {
    expect(isEditableTarget(el('SELECT'))).toBe(true);
  });

  test('contenteditable elements are editable', () => {
    expect(isEditableTarget(el('DIV', true))).toBe(true);
  });

  test('lowercase tag names are handled', () => {
    expect(isEditableTarget(el('input'))).toBe(true);
  });

  test('ordinary elements are not editable', () => {
    expect(isEditableTarget(el('DIV'))).toBe(false);
    expect(isEditableTarget(el('BUTTON'))).toBe(false);
  });

  test('null and malformed targets are not editable', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
    expect(isEditableTarget({ tagName: 42 } as unknown as EventTarget)).toBe(false);
  });
});
