// A crash leaves its `claude` runs going. Each recorded run that never ended is
// killed with its tool processes, but only while its command line still names
// that hire's folder, so a reused pid is left alone.
import { execFileSync } from 'child_process';
import type Database from 'better-sqlite3';
import log from 'electron-log';

export interface ReapDeps {
  commandOf(pid: number): string | null;
  childrenOf(pid: number): number[];
  kill(pid: number, signal: NodeJS.Signals): void;
}

function tree(deps: ReapDeps, pid: number, seen = new Set<number>()): number[] {
  if (seen.has(pid)) return [];
  seen.add(pid);
  return [...deps.childrenOf(pid).flatMap((c) => tree(deps, c, seen)), pid];
}

/** The number of leftover runs killed. Every unended run is closed as interrupted either way. */
export function reapLeftoverRuns(db: Database.Database, deps: ReapDeps): number {
  const rows = db.prepare(`SELECT id, hire_id, pid FROM crew_run WHERE ended_at IS NULL AND pid IS NOT NULL`).all() as { id: string; hire_id: string; pid: number }[];
  let killed = 0;
  for (const row of rows) {
    const command = deps.commandOf(row.pid);
    if (command?.includes(`crew/${row.hire_id}/`)) {
      for (const pid of tree(deps, row.pid)) {
        try {
          deps.kill(pid, 'SIGKILL');
        } catch (err) {
          log.warn('[Crew] could not kill a leftover run process', err);
        }
      }
      killed += 1;
    }
  }
  db.prepare(`UPDATE crew_run SET ended_at = CURRENT_TIMESTAMP, outcome = 'interrupted', pid = NULL WHERE ended_at IS NULL`).run();
  return killed;
}

const psOut = (args: string[]): string | null => {
  try {
    return execFileSync('/bin/ps', args, { encoding: 'utf8', timeout: 5000 });
  } catch {
    return null;
  }
};

export const systemReap: ReapDeps = {
  commandOf: (pid) => {
    const command = psOut(['-o', 'command=', '-p', String(pid)])?.trim();
    if (!command) return null;
    return command;
  },
  childrenOf: (pid) =>
    (psOut(['-A', '-o', 'pid=,ppid=']) ?? '')
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([child, parent]) => parent === pid && Number.isInteger(child))
      .map(([child]) => child),
  kill: (pid, signal) => process.kill(pid, signal),
};
