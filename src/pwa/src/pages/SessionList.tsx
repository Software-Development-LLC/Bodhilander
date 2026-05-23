/**
 * /sessions — placeholder. Real list view lands in BDHLNDR-55.
 */

import { Link } from 'react-router-dom';

export function SessionList() {
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
          to="/pair"
          className="block rounded-md bg-neutral-800 px-4 py-2 hover:bg-neutral-700"
        >
          Pair a new device
        </Link>
        <Link
          to="/sessions/example"
          className="block rounded-md bg-neutral-800 px-4 py-2 hover:bg-neutral-700"
        >
          Open example session
        </Link>
      </div>
    </main>
  );
}
