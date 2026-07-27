/**
 * Platform dispatch for the keyboard scheme.
 *
 * THE INVARIANT UNDER TEST: bare Ctrl belongs to the terminal. Bodhilander is a
 * terminal app, and `const isMod = e.ctrlKey || e.metaKey` — the conflation this
 * scheme replaced — is what made Ctrl+C unable to send SIGINT on Windows/Linux
 * and stole Ctrl+W (delete word), Ctrl+N (history), Ctrl+G (abort) and Ctrl+Q
 * (XON) on every platform. These are the regressions these tests exist to catch.
 *
 * The predicates take the platform explicitly (`*For` variants) because IS_MAC
 * is fixed at import time; that is the only way to exercise both branches in one
 * run. The app calls the IS_MAC-bound wrappers, which are one-line delegations.
 *
 * Run with: bun test src/renderer/hooks/__tests__
 */
import { describe, expect, test } from 'bun:test';
import {
  appKeyFor,
  appShiftKeyFor,
  hasAppModFor,
  isAppShortcutFor,
  isNewSubGroupFor,
  isSessionCycle,
  isSettingsFor,
  type KeyLike,
} from '../useKeyboardShortcuts';

const MAC = true;
const WIN = false;

/** The conventional KeyboardEvent.code for a single character. */
function defaultCode(k: string): string {
  if (/^[a-z]$/.test(k)) return `Key${k.toUpperCase()}`;
  if (/^\d$/.test(k)) return `Digit${k}`;
  return k;
}

/** Build a KeyLike. `code` defaults to the conventional code for a letter/digit. */
function key(
  k: string,
  mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {},
  code?: string,
): KeyLike {
  return {
    key: k,
    code: code ?? defaultCode(k),
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  };
}

// ---------------------------------------------------------------------------
// The headline guarantee.
// ---------------------------------------------------------------------------

describe('bare Ctrl reaches the PTY', () => {
  // Ctrl+C is the one that matters most: without this, a runaway process can
  // never be interrupted.
  const CONTROL_KEYS: Array<[string, string]> = [
    ['c', 'SIGINT'],
    ['w', 'delete word backward'],
    ['n', 'history next'],
    ['g', 'abort'],
    ['q', 'XON / flow-control resume'],
    ['a', 'beginning of line'],
    ['k', 'kill to end of line'],
    ['f', 'forward char'],
    ['r', 'reverse-i-search'],
    ['z', 'SIGTSTP'],
    ['y', 'yank'],
    ['d', 'EOF'],
    ['u', 'kill line'],
    ['e', 'end of line'],
  ];

  for (const [k, meaning] of CONTROL_KEYS) {
    test(`Ctrl+${k.toUpperCase()} (${meaning}) is not an app shortcut on Windows/Linux`, () => {
      expect(isAppShortcutFor(key(k, { ctrl: true }), WIN)).toBe(false);
    });

    test(`Ctrl+${k.toUpperCase()} (${meaning}) is not an app shortcut on macOS`, () => {
      expect(isAppShortcutFor(key(k, { ctrl: true }), MAC)).toBe(false);
    });
  }

  test('Cmd+C is an app shortcut on macOS but plain Ctrl+C is not', () => {
    expect(isAppShortcutFor(key('c', { meta: true }), MAC)).toBe(true);
    expect(isAppShortcutFor(key('c', { ctrl: true }), MAC)).toBe(false);
  });

  test('Ctrl+Shift+C is an app shortcut on Windows/Linux but plain Ctrl+C is not', () => {
    expect(isAppShortcutFor(key('c', { ctrl: true, shift: true }), WIN)).toBe(true);
    expect(isAppShortcutFor(key('c', { ctrl: true }), WIN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The base modifier.
// ---------------------------------------------------------------------------

describe('hasAppModFor', () => {
  test('macOS wants Cmd, and rejects Ctrl', () => {
    expect(hasAppModFor(key('n', { meta: true }), MAC)).toBe(true);
    expect(hasAppModFor(key('n', { ctrl: true }), MAC)).toBe(false);
  });

  test('Windows/Linux wants Ctrl+Shift, and rejects bare Ctrl', () => {
    expect(hasAppModFor(key('n', { ctrl: true, shift: true }), WIN)).toBe(true);
    expect(hasAppModFor(key('n', { ctrl: true }), WIN)).toBe(false);
  });

  test('each platform rejects the other platform s modifier', () => {
    expect(hasAppModFor(key('n', { ctrl: true, shift: true }), MAC)).toBe(false);
    expect(hasAppModFor(key('n', { meta: true }), WIN)).toBe(false);
  });

  test('Alt disqualifies on both platforms — AltGr must never trigger an action', () => {
    expect(hasAppModFor(key('n', { meta: true, alt: true }), MAC)).toBe(false);
    expect(hasAppModFor(key('n', { ctrl: true, shift: true, alt: true }), WIN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shift disambiguation: Cmd+G vs Cmd+Shift+G.
// ---------------------------------------------------------------------------

describe('appKeyFor / appShiftKeyFor', () => {
  test('macOS: a stray Shift excludes the plain row, keeping Cmd+G and Cmd+Shift+G distinct', () => {
    expect(appKeyFor(key('g', { meta: true }), 'g', 'KeyG', MAC)).toBe(true);
    expect(appKeyFor(key('g', { meta: true, shift: true }), 'g', 'KeyG', MAC)).toBe(false);
  });

  test('Windows/Linux: Shift is part of the base modifier, so it does not exclude', () => {
    expect(appKeyFor(key('g', { ctrl: true, shift: true }), 'g', 'KeyG', WIN)).toBe(true);
  });

  test('the Shift row needs Shift on macOS and is satisfied by the base modifier elsewhere', () => {
    expect(appShiftKeyFor(key('j', { meta: true, shift: true }), 'j', 'KeyJ', MAC)).toBe(true);
    expect(appShiftKeyFor(key('j', { meta: true }), 'j', 'KeyJ', MAC)).toBe(false);
    expect(appShiftKeyFor(key('j', { ctrl: true, shift: true }), 'j', 'KeyJ', WIN)).toBe(true);
  });

  test('matches on physical code when Shift mutates event.key (Ctrl+Shift+1 reports "!")', () => {
    const shifted: KeyLike = {
      key: '!', code: 'Digit1', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false,
    };
    expect(appKeyFor(shifted, '1', 'Digit1', WIN)).toBe(true);
  });

  test('matches on produced character when the layout moves the physical key', () => {
    // Dvorak: the cap printed "n" sits on the physical KeyL position.
    const dvorak: KeyLike = {
      key: 'n', code: 'KeyL', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false,
    };
    expect(appKeyFor(dvorak, 'n', 'KeyN', WIN)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The AltGr trap — the reason New Sub-Group is macOS-only.
// ---------------------------------------------------------------------------

describe('isNewSubGroupFor', () => {
  test('fires on Cmd+Shift+G on macOS', () => {
    expect(isNewSubGroupFor(key('g', { meta: true, shift: true }), MAC)).toBe(true);
  });

  test('NEVER fires on Windows/Linux — there is no safe chord left', () => {
    expect(isNewSubGroupFor(key('g', { ctrl: true, shift: true }), WIN)).toBe(false);
    expect(isNewSubGroupFor(key('g', { ctrl: true, alt: true }), WIN)).toBe(false);
    expect(isNewSubGroupFor(key('g', { meta: true, shift: true }), WIN)).toBe(false);
  });

  test('Ctrl+Shift+G on Windows/Linux is New Group, not New Sub-Group', () => {
    const e = key('g', { ctrl: true, shift: true });
    expect(appKeyFor(e, 'g', 'KeyG', WIN)).toBe(true);
    expect(isNewSubGroupFor(e, WIN)).toBe(false);
  });

  test('AltGr+G (reported as ctrl+alt on Windows) triggers nothing at all', () => {
    // On European layouts AltGr+G produces a character. If any predicate claimed
    // it, the character would never reach the shell.
    const altGr = key('g', { ctrl: true, alt: true });
    expect(isNewSubGroupFor(altGr, WIN)).toBe(false);
    expect(isAppShortcutFor(altGr, WIN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The two deliberate bare-Ctrl exceptions.
// ---------------------------------------------------------------------------

describe('isSessionCycle', () => {
  test('Ctrl+Tab and Ctrl+Shift+Tab fire on both platforms', () => {
    expect(isSessionCycle(key('Tab', { ctrl: true }))).toBe(true);
    expect(isSessionCycle(key('Tab', { ctrl: true, shift: true }))).toBe(true);
  });

  test('Cmd+Tab does NOT fire — the macOS app switcher owns it and we never see it', () => {
    expect(isSessionCycle(key('Tab', { meta: true }))).toBe(false);
  });

  test('bare Tab does not fire', () => {
    expect(isSessionCycle(key('Tab'))).toBe(false);
  });
});

describe('isSettingsFor', () => {
  test('Cmd+, on macOS, Ctrl+, on Windows/Linux', () => {
    expect(isSettingsFor(key(',', { meta: true }, 'Comma'), MAC)).toBe(true);
    expect(isSettingsFor(key(',', { ctrl: true }, 'Comma'), WIN)).toBe(true);
  });

  test('keeping bare Ctrl+, is safe: comma is not a control character', () => {
    // Documenting intent — this is the one bare-Ctrl letter-ish chord we take.
    expect(isAppShortcutFor(key(',', { ctrl: true }, 'Comma'), WIN)).toBe(true);
  });

  test('the other platform s modifier does not fire it', () => {
    expect(isSettingsFor(key(',', { ctrl: true }, 'Comma'), MAC)).toBe(false);
    expect(isSettingsFor(key(',', { meta: true }, 'Comma'), WIN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Terminal.tsx uses isAppShortcut as its withhold-from-PTY allowlist, so the
// full table matters: a false negative sends a chord to the shell, a false
// positive swallows a keystroke the user meant for their program.
// ---------------------------------------------------------------------------

describe('isAppShortcutFor covers the whole binding table', () => {
  const ROWS = ['1', '2', '3', 'n', 'w', 'b', 'g', 'c', 'v', 'a', 'k'];

  for (const k of ROWS) {
    test(`Cmd+${k} is claimed on macOS`, () => {
      expect(isAppShortcutFor(key(k, { meta: true }), MAC)).toBe(true);
    });
    test(`Ctrl+Shift+${k} is claimed on Windows/Linux`, () => {
      expect(isAppShortcutFor(key(k, { ctrl: true, shift: true }), WIN)).toBe(true);
    });
  }

  test('Next waiting: Cmd+Shift+J / Ctrl+Shift+J', () => {
    expect(isAppShortcutFor(key('j', { meta: true, shift: true }), MAC)).toBe(true);
    expect(isAppShortcutFor(key('j', { ctrl: true, shift: true }), WIN)).toBe(true);
  });

  test('an unbound letter is not claimed on either platform', () => {
    expect(isAppShortcutFor(key('x', { meta: true }), MAC)).toBe(false);
    expect(isAppShortcutFor(key('x', { ctrl: true, shift: true }), WIN)).toBe(false);
  });

  test('unmodified keys are never claimed — they belong to the PTY', () => {
    for (const k of ['a', 'c', 'g', 'Enter', 'ArrowUp']) {
      expect(isAppShortcutFor(key(k), MAC)).toBe(false);
      expect(isAppShortcutFor(key(k), WIN)).toBe(false);
    }
  });
});
