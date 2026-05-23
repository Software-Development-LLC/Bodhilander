/**
 * Tiny 3-dot overflow menu shared by header bars (SessionList, SessionDetail).
 *
 * Extracted from SessionList during BDHLNDR-56 — when only the session list
 * needed it, it was inline; now that the chat-view header needs the same
 * affordance, it lives here so we don't fork two copies. Parent owns the
 * `open` state so callers can close the menu after an action without the
 * menu needing to know what that action did.
 *
 * Behavior:
 *   - 3-dot trigger button on the right.
 *   - Floating menu pinned to the trigger's right edge.
 *   - Outside click closes (capture on document mousedown).
 *   - Each item is a button; `danger: true` flips it to a red palette for
 *     destructive actions (unpair, etc.). `disabled` shows the disabled style
 *     and blocks selection.
 *
 * Not in scope (yet): keyboard navigation (arrow keys, Escape, focus trap).
 * Mobile-first — the overflow menu is primarily touch-driven; we can layer
 * keyboard support if we ever care about desktop PWA install.
 */

import { useEffect, useRef } from 'react';

export interface OverflowMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export interface OverflowMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: OverflowMenuItem[];
  /** Accessible label for the trigger. Defaults to "Open menu". */
  ariaLabel?: string;
}

export function OverflowMenu({
  open,
  onOpenChange,
  items,
  ariaLabel = 'Open menu',
}: OverflowMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open, onOpenChange]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-800"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={item.onSelect}
              className={`block w-full px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                item.danger
                  ? 'text-red-300 hover:bg-red-900/30'
                  : 'text-neutral-200 hover:bg-neutral-800'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
