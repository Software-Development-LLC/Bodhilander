// A Windows crash can leave a run's claude going inside BodhiCrew, where it leads its own
// process group. Each such group is found by the run directory in its CREW_GH_SOCKET.
import { posix } from 'path';
import type Database from 'better-sqlite3';
import log from 'electron-log';
import { writeAudit } from './audit';
import { runDirName, type DistroSh } from './run/sockets';

export interface LeftoverRun {
  id: string;
  jobId: string;
  hireId: string;
}

const STOP_GRACE_S = 2;

export const RUN_GROUPS_SCRIPT = [
  'for d in /proc/[0-9]*; do',
  '  p=${d#/proc/}',
  `  g=$(sed 's/.*) //' "$d/stat" 2>/dev/null | cut -d' ' -f3)`,
  '  [ "$g" = "$p" ] || continue',
  `  s=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^CREW_GH_SOCKET=//p')`,
  `  [ -n "$s" ] && printf '%s %s\\n' "$p" "$s"`,
  'done; true',
].join('\n');

/** Every run the last session never ended, closed here as interrupted; the jobs were settled at table init. */
export function takeLeftoverRuns(db: Database.Database): LeftoverRun[] {
  const rows = db.prepare(`SELECT id, job_id, hire_id FROM crew_run WHERE ended_at IS NULL`).all() as { id: string; job_id: string; hire_id: string }[];
  db.prepare(`UPDATE crew_run SET ended_at = CURRENT_TIMESTAMP, outcome = 'interrupted', pid = NULL WHERE ended_at IS NULL`).run();
  return rows.map((r) => ({ id: r.id, jobId: r.job_id, hireId: r.hire_id }));
}

function liveGroups(stdout: string): Map<string, number> {
  const groups = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const m = /^(\d+) (\S+)$/.exec(line.trim());
    const pgid = m ? Number(m[1]) : 0;
    if (m && pgid > 1) groups.set(posix.basename(posix.dirname(m[2])), pgid);
  }
  return groups;
}

/** The number of leftover runs stopped. Runs as crew, so nothing outside Crew's uid can be signalled. */
export async function stopLeftoverWslRuns(db: Database.Database, sh: DistroSh, runs: LeftoverRun[]): Promise<number> {
  if (runs.length === 0) return 0;
  const listed = await sh(RUN_GROUPS_SCRIPT);
  if (listed.code !== 0) {
    log.warn('[Crew] could not list leftover runs in BodhiCrew', listed.stderr);
    return 0;
  }
  const groups = [...liveGroups(listed.stdout)];
  const found = runs.flatMap((run) => {
    const name = runDirName(run.id);
    const hit = groups.find(([dir]) => dir.startsWith(name));
    return hit ? [{ run, pgid: hit[1] }] : [];
  });
  if (found.length === 0) return 0;
  const signal = (sig: string) => found.map((f) => `kill -${sig} -${f.pgid}`).join('; ');
  await sh(`{ ${signal('TERM')}; } 2>/dev/null; sleep ${STOP_GRACE_S}; { ${signal('KILL')}; } 2>/dev/null; true`);
  for (const { run } of found) writeAudit(db, run.hireId, 'run-leftover-stopped', { runId: run.id, jobId: run.jobId, where: 'wsl' });
  return found.length;
}
