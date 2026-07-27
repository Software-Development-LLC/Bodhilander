import React, { useRef } from 'react';

interface SidebarFilterProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Text box that narrows the sidebar to matching groups, sub-groups and
 * sessions (#141).
 *
 * Ephemeral by design — the parent holds the value in plain component state so
 * it resets on every launch.
 */
export const SidebarFilter: React.FC<SidebarFilterProps> = ({ value, onChange }) => {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="sidebar-filter">
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
