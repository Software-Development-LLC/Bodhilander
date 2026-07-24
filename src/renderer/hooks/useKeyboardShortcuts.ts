import { useEffect, useCallback } from 'react';

interface ShortcutHandlers {
  onNewSession: () => void;
  onNextSession: () => void;
  onPrevSession: () => void;
  onNextWaiting: () => void;
  onCloseSession: () => void;
  onFocusSidebar: () => void;
  onNewGroup: () => void;
  onNewSubGroup?: () => void;
  onNavigateUp?: () => void;
  onNavigateDown?: () => void;
  onCollapse?: () => void;
  onExpand?: () => void;
  onSelect?: () => void;
  onToggleAnalytics?: () => void;
}

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

/**
 * Chord shortcuts (Ctrl/Cmd based). Keyed by `shift:key`, so each entry is a
 * flat lookup rather than another branch in one long conditional.
 *
 * Every one of these calls preventDefault; navigation keys deliberately do not.
 */
const MODIFIER_SHORTCUTS: Record<string, (h: ShortcutHandlers) => void> = {
  // Ctrl+N and Ctrl+Q previously ignored Shift, so both variants are listed to
  // keep the existing behaviour exactly.
  'false:n': h => h.onNewSession(),
  'true:n': h => h.onNewSession(),
  'false:q': h => h.onFocusSidebar(),
  'true:q': h => h.onFocusSidebar(),
  'false:tab': h => h.onNextSession(),
  'true:tab': h => h.onPrevSession(),
  'true:w': h => h.onNextWaiting(),
  'false:w': h => h.onCloseSession(),
  'false:g': h => h.onNewGroup(),
  'true:g': h => h.onNewSubGroup?.(),
  'true:a': h => h.onToggleAnalytics?.(),
};

/** Unmodified sidebar navigation keys. */
const NAVIGATION_KEYS: Record<string, (h: ShortcutHandlers) => void> = {
  ArrowUp: h => h.onNavigateUp?.(),
  ArrowDown: h => h.onNavigateDown?.(),
  ArrowLeft: h => h.onCollapse?.(),
  ArrowRight: h => h.onExpand?.(),
  Enter: h => h.onSelect?.(),
};

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const chord = MODIFIER_SHORTCUTS[`${e.shiftKey}:${e.key.toLowerCase()}`];
      if (chord) {
        e.preventDefault();
        chord(handlers);
        return;
      }
      // No chord matched (e.g. Ctrl+ArrowUp) — fall through to navigation, as
      // the original sequential checks did.
    }

    // Unmodified keys must never fire while the user is typing in a text field —
    // the collapse/expand handlers persist `collapsed` to the database.
    if (isEditableTarget(e.target)) return;
    NAVIGATION_KEYS[e.key]?.(handlers);
  }, [handlers]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
