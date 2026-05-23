/**
 * /sessions/:sessionId — placeholder. Real chat view lands in BDHLNDR-56.
 */

import { Link, useParams } from 'react-router-dom';

export function SessionDetail() {
  const { sessionId } = useParams<{ sessionId: string }>();

  return (
    <main className="mx-auto max-w-md p-4">
      <nav className="mb-4 text-sm text-neutral-400">
        <Link to="/sessions" className="hover:text-neutral-200">
          Sessions
        </Link>
        <span className="mx-2">/</span>
        <span className="text-neutral-200">{sessionId ?? '(unknown)'}</span>
      </nav>
      <h1 className="text-2xl font-semibold">
        Session <span className="font-mono text-base text-neutral-400">{sessionId}</span>
      </h1>
      <p className="mt-2 text-neutral-300">
        Chat view lands in BDHLNDR-56.
      </p>
    </main>
  );
}
