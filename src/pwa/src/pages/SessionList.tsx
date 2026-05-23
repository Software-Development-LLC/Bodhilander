/**
 * /sessions — placeholder list (real list view lands in BDHLNDR-55).
 *
 * For BDHLNDR-54 we add the unpair-this-device button at the bottom so the
 * pair → store → redirect flow has a working "back out" path. When the
 * server-side DELETE succeeds (or returns the specific "Cannot unpair the
 * current device" message — see note below) we wipe IndexedDB and bounce
 * back to /pair.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ApiError, apiFetch } from '../lib/api';
import { clearAuth, getAuth } from '../lib/auth';

export function SessionList() {
  const navigate = useNavigate();
  const [unpairing, setUnpairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUnpair() {
    setError(null);
    setUnpairing(true);
    try {
      const auth = await getAuth();
      if (!auth) {
        // Nothing to unpair — just bounce.
        navigate('/pair', { replace: true });
        return;
      }

      try {
        await apiFetch(`/pairing/devices/${encodeURIComponent(auth.device.id)}`, {
          method: 'DELETE',
        });
      } catch (err) {
        // The desktop rejects self-unpair with HTTP 400 ("Cannot unpair the
        // current device"). From the PWA's perspective the user is asking
        // to forget *this* token, so we still clear locally — they can
        // unpair from the desktop UI if they want the row gone server-side.
        // Re-throw anything else.
        if (!(err instanceof ApiError && err.status === 400)) {
          throw err;
        }
      }

      await clearAuth();
      navigate('/pair', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnpairing(false);
    }
  }

  return (
    <main className="mx-auto max-w-md p-4">
      <nav className="mb-4 text-sm text-neutral-400">
        <span className="text-neutral-200">Sessions</span>
      </nav>
      <h1 className="text-2xl font-semibold">Sessions</h1>
      <p className="mt-2 text-neutral-300">
        Session list lands in BDHLNDR-55.
      </p>
      <div className="mt-6 space-y-2 text-sm">
        <Link
          to="/sessions/example"
          className="block rounded-md bg-neutral-800 px-4 py-2 hover:bg-neutral-700"
        >
          Open example session
        </Link>
      </div>

      <div className="mt-8 border-t border-neutral-800 pt-4">
        <button
          type="button"
          onClick={handleUnpair}
          disabled={unpairing}
          className="w-full rounded-md border border-red-700/60 bg-red-900/20 px-4 py-2 text-sm text-red-200 transition-colors hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {unpairing ? 'Unpairing…' : 'Unpair this device'}
        </button>
        {error && (
          <p role="alert" className="mt-2 text-xs text-red-300">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
