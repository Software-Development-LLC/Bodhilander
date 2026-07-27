import { useEffect, useCallback } from 'react';

/* ===========================================================================
 * THE KEYBOARD SCHEME — read this before touching anything below.
 *
 * THE RULE: bare Ctrl ALWAYS belongs to the terminal. Bodhilander is a
 * terminal app; Ctrl+C/W/N/G/Q/A/K/F are job-control and readline keys the PTY
 * needs. Never write `const isMod = e.ctrlKey || e.metaKey` again — that
 * conflation is exactly what made Ctrl+C unable to send SIGINT on
 * Windows/Linux and stole Ctrl+W (delete word), Ctrl+N (history), Ctrl+G
 * (abort) and Ctrl+Q (XON) on every platform.
 *
 * App actions therefore use a platform-specific modifier, the same split
 * Windows Terminal, GNOME Terminal and iTerm2 use:
 *     macOS         -> Cmd
 *     Windows/Linux -> Ctrl+Shift
 *
 *   Action            | macOS          | Windows/Linux   | owner
 *   ------------------|----------------|-----------------|--------------------
 *   Terminal view     | Cmd+1          | Ctrl+Shift+1    | here + menu
 *   Analytics view    | Cmd+2          | Ctrl+Shift+2    | here + menu
 *   Arena view        | Cmd+3          | Ctrl+Shift+3    | here + menu
 *   New session       | Cmd+N          | Ctrl+Shift+N    | here + menu
 *   Close session     | Cmd+W          | Ctrl+Shift+W    | here + menu
 *   Next session      | Ctrl+Tab       | Ctrl+Tab        | here + menu
 *   Prev session      | Ctrl+Shift+Tab | Ctrl+Shift+Tab  | here + menu
 *   Next waiting      | Cmd+Shift+J    | Ctrl+Shift+J    | here + menu
 *   Focus sidebar     | Cmd+B          | Ctrl+Shift+B    | here + menu
 *   New group         | Cmd+G          | Ctrl+Shift+G    | here
 *   New sub-group     | Cmd+Shift+G    | (none)          | here
 *   Settings          | Cmd+,          | Ctrl+,          | menu only
 *   Copy              | Cmd+C          | Ctrl+Shift+C    | menu + Terminal.tsx
 *   Paste             | Cmd+V          | Ctrl+Shift+V    | menu + Terminal.tsx
 *   Select all        | Cmd+A          | Ctrl+Shift+A    | menu only
 *   Clear terminal    | Cmd+K          | Ctrl+Shift+K    | menu only
 *
 * Three rows break the pattern, on purpose:
 *  - Ctrl+Tab / Ctrl+Shift+Tab are identical on both platforms. Tab is not a
 *    readline key so borrowing bare Ctrl is safe, and Cmd+Tab could never work
 *    on macOS because the OS app switcher eats it before we see it.
 *  - New sub-group is macOS-only (Cmd+Shift+G). Windows/Linux has no safe chord
 *    left — Shift is already spent on the base modifier and Ctrl+Alt is AltGr.
 *    See isNewSubGroup for the full reasoning; it stays reachable everywhere
 *    from the group context menu and the per-group "+" button.
 *  - Settings keeps bare Ctrl+, on Windows/Linux. Comma is not a control
 *    character, so the PTY loses nothing.
 *
 * Most rows are ALSO registered as menu accelerators in main/menu.ts. Electron
 * consumes menu accelerators before the renderer ever sees the keydown, so in
 * practice the menu wins and the handlers here are the fallback path (menu
 * hidden/disabled, or a binding the menu does not carry, e.g. New Group). Both
 * paths must agree — hence one table, in one file.
 *
 * Terminal.tsx imports `isAppShortcut` from here as the allowlist of keystrokes
 * it withholds from the PTY, so the "what belongs to the app" decision is made
 * exactly once.
 * =========================================================================== */

interface ShortcutHandlers {
  onNewSession: () => void;
  onNextSession: () => void;
  onPrevSession: () => void;
  onNextWaiting: () => void;
  onCloseSession: () => void;
  onFocusSidebar: () => void;
  onNewGroup: () => void;
  onViewTerminal: () => void;
  onViewAnalytics: () => void;
  onViewArena: () => void;
  onNewSubGroup?: () => void;
  onNavigateUp?: () => void;
  onNavigateDown?: () => void;
  onCollapse?: () => void;
  onExpand?: () => void;
  onSelect?: () => void;
}

/** True on macOS. `platform` is exposed by preload.ts (process.platform). */
export const IS_MAC = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';

/**
 * The subset of KeyboardEvent these predicates read.
 *
 * Declared structurally so tests can pass plain objects. Every predicate below
 * is pure and takes the platform as an argument rather than closing over
 * IS_MAC, because IS_MAC is fixed at import time — parameterising is the only
 * way to exercise both platform branches in one test run. The thin
 * IS_MAC-bound wrappers further down are what the app itself calls.
 */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/**
 * Match a key by produced character OR physical position. Both are needed:
 * Shift mutates `event.key` (Ctrl+Shift+1 reports '!' on a US layout) while
 * `event.code` stays put; conversely `event.key` is what a Dvorak/AZERTY user
 * sees printed on the cap.
 */
const isKey = (e: KeyLike, key: string, code: string) =>
  e.key.toLowerCase() === key || e.code === code;

/**
 * The app-action modifier: Cmd on macOS, Ctrl+Shift elsewhere. Each branch
 * rejects the other platform's modifier so that bare Ctrl — on BOTH platforms —
 * falls straight through to the terminal.
 */
export const hasAppModFor = (e: KeyLike, isMac: boolean) =>
  isMac
    ? e.metaKey && !e.ctrlKey && !e.altKey
    : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;

const hasAppMod = (e: KeyLike) => hasAppModFor(e, IS_MAC);

/**
 * Table rows written "Cmd+X / Ctrl+Shift+X". On Windows/Linux Shift is already
 * part of the base modifier, so only macOS has to reject a stray Shift (which
 * is what keeps Cmd+G and Cmd+Shift+G distinct there).
 */
export const appKeyFor = (e: KeyLike, key: string, code: string, isMac: boolean) =>
  hasAppModFor(e, isMac) && (isMac ? !e.shiftKey : true) && isKey(e, key, code);

const appKey = (e: KeyLike, key: string, code: string) => appKeyFor(e, key, code, IS_MAC);

/**
 * Table rows written "Cmd+Shift+X / Ctrl+Shift+X" (Next waiting). macOS needs
 * the extra Shift; on Windows/Linux the base modifier already supplies it.
 */
export const appShiftKeyFor = (e: KeyLike, key: string, code: string, isMac: boolean) =>
  hasAppModFor(e, isMac) && (isMac ? e.shiftKey : true) && isKey(e, key, code);

const appShiftKey = (e: KeyLike, key: string, code: string) => appShiftKeyFor(e, key, code, IS_MAC);

/**
 * New sub-group — Cmd+Shift+G, macOS ONLY. The platform asymmetry is deliberate;
 * do not "fix" it by adding a Windows/Linux chord.
 *
 * Windows/Linux already spends Shift on the base modifier (Ctrl+Shift+G is New
 * Group there), so the obvious third modifier is Alt — and that is exactly the
 * trap. On Windows, AltGr reports as `ctrlKey && altKey` and nothing
 * distinguishes it from a real Ctrl+Alt, so Ctrl+Alt+G is indistinguishable
 * from AltGr+G. On the many European layouts where AltGr+G produces a character,
 * typing that character would create a sub-group and the character would never
 * reach the shell. macOS has no AltGr, so Cmd+Shift+G is safe there.
 *
 * Nothing becomes unreachable: New Sub-Group is on the group context menu and
 * behind the per-group "+" button on every platform.
 */
export const isNewSubGroupFor = (e: KeyLike, isMac: boolean) =>
  isMac && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && isKey(e, 'g', 'KeyG');

const isNewSubGroup = (e: KeyLike) => isNewSubGroupFor(e, IS_MAC);

/**
 * Next/Prev session — Ctrl+Tab / Ctrl+Shift+Tab on both platforms. Keyed on
 * ctrlKey specifically and never metaKey: Cmd+Tab is the macOS app switcher,
 * which is why the old `isMod && key === 'Tab'` never fired there.
 */
export const isSessionCycle = (e: KeyLike) =>
  e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab';

/**
 * Settings — Cmd+, / Ctrl+,. Handled entirely by the main-process menu; listed
 * here only so Terminal.tsx knows to keep it away from the PTY.
 */
export const isSettingsFor = (e: KeyLike, isMac: boolean) =>
  (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) &&
  !e.altKey && !e.shiftKey && isKey(e, ',', 'Comma');

const isSettings = (e: KeyLike) => isSettingsFor(e, IS_MAC);

/** Copy — Cmd+C / Ctrl+Shift+C. Terminal.tsx implements the terminal-local half. */
export const isCopyShortcut = (e: KeyLike) => appKey(e, 'c', 'KeyC');

/** Paste — Cmd+V / Ctrl+Shift+V. Terminal.tsx implements the terminal-local half. */
export const isPasteShortcut = (e: KeyLike) => appKey(e, 'v', 'KeyV');

/**
 * "This keystroke belongs to the app, not to the PTY."
 *
 * Terminal.tsx uses this as the allowlist of keystrokes it withholds from the
 * PTY, so the two files can never drift. Anything this returns false for MUST
 * reach the shell — in particular every bare Ctrl+<letter> combination. The only
 * bare-Ctrl chords this claims are the two the table calls out (Ctrl+Tab and
 * Ctrl+,), neither of which the PTY wants.
 */
export function isAppShortcutFor(e: KeyLike, isMac: boolean): boolean {
  const key = (k: string, code: string) => appKeyFor(e, k, code, isMac);
  if (isSessionCycle(e)) return true;                 // Ctrl+Tab / Ctrl+Shift+Tab
  if (isSettingsFor(e, isMac)) return true;           // Cmd+, / Ctrl+,
  if (isNewSubGroupFor(e, isMac)) return true;        // Cmd+Shift+G (macOS only)
  if (appShiftKeyFor(e, 'j', 'KeyJ', isMac)) return true; // Next waiting
  return (
    key('1', 'Digit1') ||                             // Terminal view
    key('2', 'Digit2') ||                             // Analytics view
    key('3', 'Digit3') ||                             // Arena view
    key('n', 'KeyN') ||                               // New session
    key('w', 'KeyW') ||                               // Close session
    key('b', 'KeyB') ||                               // Focus sidebar
    key('g', 'KeyG') ||                               // New group
    key('c', 'KeyC') ||                               // Copy         (Edit menu)
    key('v', 'KeyV') ||                               // Paste        (Edit menu)
    key('a', 'KeyA') ||                               // Select all   (Edit menu)
    key('k', 'KeyK')                                  // Clear        (Edit menu)
  );
}

export function isAppShortcut(e: KeyLike): boolean {
  return isAppShortcutFor(e, IS_MAC);
}

/**
 * True when the caret is in the terminal or any text field. Bare arrows and
 * Enter drive the sidebar list, and they must never act from there: arrows are
 * readline motion/history keys, and xterm's preventDefault does NOT stop the
 * keydown from bubbling up to our window listener. xterm's focus target is a
 * hidden <textarea>, so the tag check covers it; the closest() check covers
 * clicks that land on the terminal wrapper itself.
 */
const isTextEntryFocused = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (isEditableTarget(el)) return true;
  // Extra case isEditableTarget can't see: focus parked on the xterm wrapper
  // rather than its hidden textarea. Arrows belong to the shell there.
  return !!el.closest?.('.terminal-container, .xterm');
};

/**
 * True when a keystroke originated inside a text-entry surface — the sidebar
 * filter box, an inline rename input, or the terminal's hidden textarea.
 *
 * Such targets own the *unmodified* keys (arrows, Enter): stealing them would
 * move the sidebar selection while the user is editing text, and the sidebar's
 * arrow handlers persist `collapsed` to the database. Modifier shortcuts
 * (Ctrl+N, Ctrl+W, …) are deliberately NOT affected and still work everywhere.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { tagName?: string }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Next / Prev session — Ctrl+Tab, Ctrl+Shift+Tab (identical both platforms)
    if (isSessionCycle(e)) {
      e.preventDefault();
      if (e.shiftKey) {
        handlers.onPrevSession();
      } else {
        handlers.onNextSession();
      }
      return;
    }

    // New sub-group — Cmd+Shift+G, macOS only (no Windows/Linux chord is safe;
    // see isNewSubGroup). Checked before New Group because on macOS both start
    // Cmd+G and only the Shift tells them apart.
    if (isNewSubGroup(e)) {
      e.preventDefault();
      handlers.onNewSubGroup?.();
      return;
    }

    // Next waiting — Cmd+Shift+J / Ctrl+Shift+J
    if (appShiftKey(e, 'j', 'KeyJ')) {
      e.preventDefault();
      handlers.onNextWaiting();
      return;
    }

    // View switcher — Cmd+1/2/3 / Ctrl+Shift+1/2/3. Digits, not letters, so the
    // View menu's reload/zoom/devtools roles keep their accelerators.
    if (appKey(e, '1', 'Digit1')) {
      e.preventDefault();
      handlers.onViewTerminal();
      return;
    }
    if (appKey(e, '2', 'Digit2')) {
      e.preventDefault();
      handlers.onViewAnalytics();
      return;
    }
    if (appKey(e, '3', 'Digit3')) {
      e.preventDefault();
      handlers.onViewArena();
      return;
    }

    // New session — Cmd+N / Ctrl+Shift+N
    if (appKey(e, 'n', 'KeyN')) {
      e.preventDefault();
      handlers.onNewSession();
      return;
    }

    // Close session — Cmd+W / Ctrl+Shift+W
    if (appKey(e, 'w', 'KeyW')) {
      e.preventDefault();
      handlers.onCloseSession();
      return;
    }

    // Focus sidebar — Cmd+B / Ctrl+Shift+B. Replaces the old Cmd+Q, which
    // macOS handed to the menu's quit role before the renderer saw it (so the
    // shortcut quit the app instead of focusing the sidebar). Ctrl+Shift+B on
    // Windows/Linux also dodges tmux's Ctrl+B prefix.
    if (appKey(e, 'b', 'KeyB')) {
      e.preventDefault();
      handlers.onFocusSidebar();
      return;
    }

    // New group — Cmd+G / Ctrl+Shift+G
    if (appKey(e, 'g', 'KeyG')) {
      e.preventDefault();
      handlers.onNewGroup();
      return;
    }

    // --- Sidebar navigation: bare arrows / Enter, no modifiers ---------------
    // App.tsx's handlers already bail unless the sidebar is focused; the
    // isTextEntryFocused() check is the second line of defence so these can
    // never steal a keystroke from the shell or from a rename field.
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    // Check the event's own target as well as the focused element (#141): the
    // sidebar's collapse/expand handlers persist `collapsed` to the database,
    // so an arrow key typed in the filter box must never reach them.
    if (isEditableTarget(e.target) || isTextEntryFocused()) return;

    switch (e.key) {
      case 'ArrowUp':
        handlers.onNavigateUp?.();
        break;
      case 'ArrowDown':
        handlers.onNavigateDown?.();
        break;
      case 'ArrowLeft':
        handlers.onCollapse?.();
        break;
      case 'ArrowRight':
        handlers.onExpand?.();
        break;
      case 'Enter':
        handlers.onSelect?.();
        break;
    }
  }, [handlers]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
