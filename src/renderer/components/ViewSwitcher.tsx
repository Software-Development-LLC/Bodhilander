import React, { useCallback } from 'react';

/**
 * The content area hosts exactly one destination at a time. A single
 * discriminated value (rather than one boolean per panel) makes "Analytics and
 * Arena are both open" unrepresentable — that used to happen with two
 * independent booleans.
 */
export type ContentView = 'terminal' | 'analytics' | 'arena';

/**
 * Tab strip at the top of the content area. Digits (not letters) because the
 * View menu roles already own Cmd/Ctrl+R, 0, +, - and we must not collide.
 */
export const VIEW_TABS: Array<{ id: ContentView; label: string; digit: string }> = [
  { id: 'terminal', label: 'Terminal', digit: '1' },
  { id: 'analytics', label: 'Analytics', digit: '2' },
  { id: 'arena', label: 'Arena', digit: '3' },
];

interface ViewSwitcherProps {
  value: ContentView;
  onChange: (next: ContentView) => void;
  /** '⌘' on macOS, 'Ctrl+Shift+' elsewhere — shown in each tab's tooltip. */
  shortcutPrefix: string;
}

/**
 * Tablist for the three content destinations, implementing the standard roving
 * tabindex pattern: exactly one tab is in the tab order, and arrows/Home/End
 * move between them.
 */
export const ViewSwitcher: React.FC<ViewSwitcherProps> = ({ value, onChange, shortcutPrefix }) => {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const currentIndex = VIEW_TABS.findIndex(tab => tab.id === value);
      let nextIndex = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        nextIndex = (currentIndex + 1) % VIEW_TABS.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        nextIndex = (currentIndex - 1 + VIEW_TABS.length) % VIEW_TABS.length;
      } else if (e.key === 'Home') {
        nextIndex = 0;
      } else if (e.key === 'End') {
        nextIndex = VIEW_TABS.length - 1;
      }
      if (nextIndex === -1) return;

      e.preventDefault();
      e.stopPropagation(); // don't also drive the sidebar's arrow navigation

      const next = VIEW_TABS[nextIndex];
      onChange(next.id);

      // Focus follows selection, or the roving tabIndex breaks: the tab still
      // holding DOM focus would be left at tabIndex={-1} while the focus ring
      // stayed behind the visual selection.
      //
      // Resolve from the TABLIST, not from e.currentTarget. The handler lives on
      // the tab buttons (they are what take focus), so currentTarget is a
      // SIBLING of the tab we want — querying its descendants finds nothing and
      // the ?.focus() silently no-ops.
      e.currentTarget
        .closest('[role="tablist"]')
        ?.querySelector<HTMLButtonElement>(`#view-tab-${next.id}`)
        ?.focus();
    },
    [value, onChange],
  );

  return (
    <div className="view-switcher" role="tablist" aria-label="Content view">
      {VIEW_TABS.map(tab => (
        <button
          key={tab.id}
          id={`view-tab-${tab.id}`}
          className={`view-tab ${value === tab.id ? 'active' : ''}`}
          role="tab"
          aria-selected={value === tab.id}
          aria-controls={`view-panel-${tab.id}`}
          // Roving tabIndex: Tab reaches the strip once, arrows move within it.
          tabIndex={value === tab.id ? 0 : -1}
          title={`${tab.label} (${shortcutPrefix}${tab.digit})`}
          onClick={() => onChange(tab.id)}
          onKeyDown={handleKeyDown}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
};
