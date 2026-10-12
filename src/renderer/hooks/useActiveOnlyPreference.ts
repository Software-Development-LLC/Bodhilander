import { useState, useRef, useEffect, useCallback } from 'react';

export const ACTIVE_ONLY_PREF_KEY = 'sidebar.showActiveOnly';

/**
 * Persisted "show only active sessions" toggle (#149), backed by the
 * preferences table via `getPreference` / `setPreference`.
 *
 * Loads once on mount. A user interaction that happens before that async read
 * resolves wins — the stale read is ignored — so in-memory state and storage
 * never diverge. Missing/unreadable preference ⇒ off.
 */
export function useActiveOnlyPreference(): [boolean, (next: boolean) => void] {
  const [showActiveOnly, setShowActiveOnly] = useState(false);
  const touched = useRef(false);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.getPreference(ACTIVE_ONLY_PREF_KEY)
      .then(v => {
        // Don't clobber a value the user already set while the read was in flight.
        if (cancelled || touched.current) return;
        setShowActiveOnly(v === 'true');
      })
      .catch(() => { /* preferences unavailable — leave off */ });
    return () => { cancelled = true; };
  }, []);

  const setActiveOnly = useCallback((next: boolean) => {
    touched.current = true;
    setShowActiveOnly(next);
    window.electronAPI.setPreference(ACTIVE_ONLY_PREF_KEY, String(next))
      .catch(err => console.error('Failed to persist showActiveOnly:', err));
  }, []);

  return [showActiveOnly, setActiveOnly];
}
