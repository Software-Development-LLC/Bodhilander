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

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const isMod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (isMod && key === 'n') {
      e.preventDefault();
      handlers.onNewSession();
    }

    if (isMod && e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        handlers.onPrevSession();
      } else {
        handlers.onNextSession();
      }
    }

    // Ctrl+Shift+W = Next waiting (check before Ctrl+W)
    if (isMod && e.shiftKey && key === 'w') {
      e.preventDefault();
      handlers.onNextWaiting();
      return;
    }

    // Ctrl+W = Close session
    if (isMod && key === 'w') {
      e.preventDefault();
      handlers.onCloseSession();
    }

    // Ctrl+Q = Focus sidebar
    if (isMod && key === 'q') {
      e.preventDefault();
      handlers.onFocusSidebar();
    }

    // Ctrl+G = New group
    if (isMod && !e.shiftKey && key === 'g') {
      e.preventDefault();
      handlers.onNewGroup();
    }

    // Ctrl+Shift+G = New sub-group
    if (isMod && e.shiftKey && key === 'g') {
      e.preventDefault();
      handlers.onNewSubGroup?.();
    }

    // Arrow keys / Enter (for sidebar navigation). These are unmodified keys, so
    // they must never fire while the user is typing in a text field — the
    // collapse/expand handlers persist `collapsed` to the database.
    if (!isEditableTarget(e.target)) {
      if (e.key === 'ArrowUp') {
        handlers.onNavigateUp?.();
      }
      if (e.key === 'ArrowDown') {
        handlers.onNavigateDown?.();
      }
      if (e.key === 'ArrowLeft') {
        handlers.onCollapse?.();
      }
      if (e.key === 'ArrowRight') {
        handlers.onExpand?.();
      }
      if (e.key === 'Enter' && handlers.onSelect) {
        handlers.onSelect();
      }
    }

    // Ctrl+Shift+A = Analytics dashboard
    if (isMod && e.shiftKey && key === 'a') {
      e.preventDefault();
      handlers.onToggleAnalytics?.();
    }
  }, [handlers]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
