/**
 * Top-level route table for the mobile PWA.
 *
 * Pages here are intentionally placeholders — the real implementations land
 * in follow-up tickets:
 *   - /pair                → BDHLNDR-54 (pair flow + IndexedDB token storage)
 *   - /sessions            → BDHLNDR-55 (session list)
 *   - /sessions/:sessionId → BDHLNDR-56 (chat view consuming chat-events)
 */

import { Navigate, Route, Routes } from 'react-router-dom';

import { Pair } from './pages/Pair';
import { SessionList } from './pages/SessionList';
import { SessionDetail } from './pages/SessionDetail';

export function App() {
  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-100">
      <Routes>
        <Route path="/" element={<Navigate to="/sessions" replace />} />
        <Route path="/pair" element={<Pair />} />
        <Route path="/sessions" element={<SessionList />} />
        <Route path="/sessions/:sessionId" element={<SessionDetail />} />
        {/* Unknown paths bounce back to the session list so the SPA fallback
            from the desktop never lands on a blank screen. */}
        <Route path="*" element={<Navigate to="/sessions" replace />} />
      </Routes>
    </div>
  );
}
