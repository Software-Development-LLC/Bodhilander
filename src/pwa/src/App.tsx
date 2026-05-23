/**
 * Top-level route table for the mobile PWA.
 *
 * Real implementations of the placeholders land in follow-ups:
 *   - /pair                → BDHLNDR-54 (this ticket: typed pair flow)
 *   - /sessions            → BDHLNDR-55 (session list)
 *   - /sessions/:sessionId → BDHLNDR-56 (chat view consuming chat-events)
 *
 * <RequireAuth> is a wrapper component (not a layout route) so each
 * protected route can opt in individually — the more common react-router-v7
 * shape and the one that matches our flat route table.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { Pair } from './pages/Pair';
import { SessionList } from './pages/SessionList';
import { SessionDetail } from './pages/SessionDetail';
import { InstallPrompt } from './components/InstallPrompt';
import { getAuth } from './lib/auth';

export function App() {
  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-100">
      <Routes>
        <Route path="/" element={<Navigate to="/sessions" replace />} />
        <Route path="/pair" element={<Pair />} />
        <Route
          path="/sessions"
          element={
            <RequireAuth>
              <SessionList />
            </RequireAuth>
          }
        />
        <Route
          path="/sessions/:sessionId"
          element={
            <RequireAuth>
              <SessionDetail />
            </RequireAuth>
          }
        />
        {/* Unknown paths bounce back to the session list so the SPA fallback
            from the desktop never lands on a blank screen. */}
        <Route path="*" element={<Navigate to="/sessions" replace />} />
      </Routes>
      {/* BDHLNDR-61: always-mounted install walkthrough. Self-gates on
          platform + standalone state + paired_at; renders nothing until
          conditions are met. Placed as a <Routes> sibling so it stays up
          across navigation. */}
      <InstallPrompt />
    </div>
  );
}

/**
 * Gate a route on having an auth row in IndexedDB. While the check is in
 * flight we render a blank shell to avoid a flash of either the protected
 * page or /pair.
 */
function RequireAuth({ children }: { children: ReactElement }): ReactElement {
  const [state, setState] = useState<'checking' | 'authed' | 'unauthed'>('checking');

  useEffect(() => {
    let cancelled = false;
    getAuth().then((auth) => {
      if (cancelled) return;
      setState(auth ? 'authed' : 'unauthed');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'checking') {
    // Empty shell — the IndexedDB read is fast, this is sub-frame in
    // practice. Avoids a flash of /pair for paired users.
    return <div aria-hidden className="min-h-screen" />;
  }

  if (state === 'unauthed') {
    return <Navigate to="/pair" replace />;
  }

  return children;
}
