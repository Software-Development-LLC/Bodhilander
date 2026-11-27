import { describe, expect, mock, test } from 'bun:test';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const { reapLeftoverRuns } = await import('../reap');
import type { ReapDeps } from '../reap';
import { HIRE, HIRE_B, crewDb } from '../../__tests__/crew-db';

function fakeProcs(procs: Record<number, { command: string; parent: number }>) {
  const killed: [number, string][] = [];
  const deps: ReapDeps = {
    commandOf: (pid) => procs[pid]?.command ?? null,
    childrenOf: (pid) => Object.entries(procs).filter(([, p]) => p.parent === pid).map(([c]) => Number(c)),
    kill: (pid, signal) => void killed.push([pid, signal]),
  };
  return { deps, killed };
}

describe('leftover runs after a crash', () => {
  test("an unended run whose process still names its hire's folder is killed with its tool processes, children first", () => {
    const { raw, db } = crewDb();
    raw.query(`INSERT INTO crew_run (id, job_id, hire_id, pid) VALUES ('r1', 'j1', ?, 100)`).run(HIRE);
    const { deps, killed } = fakeProcs({
      100: { command: `node /usr/local/bin/claude -p --settings /ud/crew/${HIRE}/run/settings-owner.json`, parent: 1 },
      101: { command: 'bash -c make', parent: 100 },
      102: { command: 'make', parent: 101 },
    });
    expect(reapLeftoverRuns(db, deps)).toBe(1);
    expect(killed).toEqual([[102, 'SIGKILL'], [101, 'SIGKILL'], [100, 'SIGKILL']]);
    expect(raw.query(`SELECT outcome, pid, ended_at IS NOT NULL AS ended FROM crew_run`).get()).toEqual({ outcome: 'interrupted', pid: null, ended: 1 });
    const audits = raw.query(`SELECT hire_id, detail FROM crew_audit WHERE event = 'run-leftover-stopped'`).all() as { hire_id: string; detail: string }[];
    expect(audits.map((a) => [a.hire_id, JSON.parse(a.detail)])).toEqual([[HIRE, { runId: 'r1', jobId: 'j1', where: 'native' }]]);
  });

  test('a pid now used by something else, a run that ended, or a gone process is left alone', () => {
    const { raw, db } = crewDb();
    raw.query(`INSERT INTO crew_run (id, job_id, hire_id, pid) VALUES ('r1', 'j1', ?, 100)`).run(HIRE);
    raw.query(`INSERT INTO crew_run (id, job_id, hire_id, pid) VALUES ('r2', 'j2', ?, 200)`).run(HIRE_B);
    raw.query(`INSERT INTO crew_run (id, job_id, hire_id, pid, ended_at, outcome) VALUES ('r3', 'j3', ?, 300, CURRENT_TIMESTAMP, 'done')`).run(HIRE);
    const { deps, killed } = fakeProcs({
      100: { command: '/Applications/Safari.app/Contents/MacOS/Safari', parent: 1 },
      200: { command: `claude -p --settings /ud/crew/${HIRE}/run/settings-owner.json`, parent: 1 },
      300: { command: `claude -p --settings /ud/crew/${HIRE}/run/settings-owner.json`, parent: 1 },
    });
    expect(reapLeftoverRuns(db, deps)).toBe(0);
    expect(killed).toEqual([]);
    expect(raw.query(`SELECT COUNT(*) AS n FROM crew_audit`).get()).toEqual({ n: 0 });
    expect(raw.query(`SELECT id, outcome FROM crew_run ORDER BY id`).all()).toEqual([
      { id: 'r1', outcome: 'interrupted' }, { id: 'r2', outcome: 'interrupted' }, { id: 'r3', outcome: 'done' },
    ]);
  });
});
