/**
 * When a hire changes account, each thread's session is copied into the new
 * account's config dir. A thread whose copy fails loses its session id, so
 * its next run starts fresh with the last turns.
 */
import type Database from 'better-sqlite3';
import { carryTranscript } from '../conversation-transcript';

export interface CarryResult {
  carried: number;
  fresh: number;
}

export function carryHireSessions(
  db: Database.Database,
  hireId: string,
  to: { id: string; configDir: string },
  configDirOf: (accountId: string) => string | null,
  carry: typeof carryTranscript = carryTranscript,
): CarryResult {
  const threads = db
    .prepare(`SELECT thread_key, session_id, account_id FROM crew_thread WHERE hire_id = ?`)
    .all(hireId) as { thread_key: string; session_id: string | null; account_id: string | null }[];
  const result: CarryResult = { carried: 0, fresh: 0 };
  const update = db.prepare(
    `UPDATE crew_thread SET session_id = ?, account_id = ?, updated_at = CURRENT_TIMESTAMP WHERE hire_id = ? AND thread_key = ?`,
  );
  for (const thread of threads) {
    if (!thread.session_id || thread.account_id === to.id) {
      update.run(thread.session_id, to.id, hireId, thread.thread_key);
      continue;
    }
    const fromDir = thread.account_id ? configDirOf(thread.account_id) : null;
    const ok = fromDir !== null && carry(thread.session_id, fromDir, to.configDir);
    update.run(ok ? thread.session_id : null, to.id, hireId, thread.thread_key);
    if (ok) result.carried += 1;
    else result.fresh += 1;
  }
  return result;
}
