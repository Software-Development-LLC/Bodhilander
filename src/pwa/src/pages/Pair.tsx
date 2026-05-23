/**
 * /pair — placeholder. Real pairing flow lands in BDHLNDR-54.
 */

import { Link } from 'react-router-dom';

export function Pair() {
  return (
    <main className="mx-auto max-w-md p-4">
      <nav className="mb-4 text-sm text-neutral-400">
        <Link to="/sessions" className="hover:text-neutral-200">
          Sessions
        </Link>
        <span className="mx-2">/</span>
        <span className="text-neutral-200">Pair</span>
      </nav>
      <h1 className="text-2xl font-semibold">Pair device</h1>
      <p className="mt-2 text-neutral-300">
        Pairing UI lands in BDHLNDR-54.
      </p>
    </main>
  );
}
