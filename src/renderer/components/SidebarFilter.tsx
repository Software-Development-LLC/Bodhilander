import React, { useRef } from 'react';

interface SidebarFilterProps {
  value: string;
  onChange: (value: string) => void;
  /** When true, the sidebar shows only groups with an active session (#149). */
  activeOnly: boolean;
  onActiveOnlyChange: (value: boolean) => void;
}

/**
 * The sidebar's filter controls: an active-only toggle and a text box that
 * narrow the group/session tree (#141, #149).
 *
 * The text query is ephemeral (parent state, resets each launch); the toggle is
 * persisted by the parent.
 */
export const SidebarFilter: React.FC<SidebarFilterProps> = ({
  value, onChange, activeOnly, onActiveOnlyChange,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="sidebar-filter">
      <button
        type="button"
        className={`sidebar-filter-toggle ${activeOnly ? 'active' : ''}`}
        aria-pressed={activeOnly}
        title="Show only groups with active sessions"
        aria-label="Show only groups with active sessions"
        onClick={() => onActiveOnlyChange(!activeOnly)}
      >
        ⚡
      </button>
      <div className="sidebar-filter-field">
        <input
          ref={inputRef}
          className="sidebar-filter-input"
          type="text"
          value={value}
          placeholder="Filter groups &amp; sessions…"
          aria-label="Filter groups and sessions"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            if (value) {
              // Consume the first Escape to clear the query.
              e.stopPropagation();
              onChange('');
            } else {
              // Already empty: step out so keyboard users have a route back,
              // and let app-level dismiss handlers see the key.
              inputRef.current?.blur();
            }
          }}
        />
        {value && (
          <button
            className="sidebar-filter-clear"
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
            title="Clear filter"
            aria-label="Clear filter"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
};
