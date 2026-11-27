import { describe, expect, mock, test } from 'bun:test';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const { RUN_GROUPS_SCRIPT, stopLeftoverWslRuns, takeLeftoverRuns } = await import('../wsl-reap');
const { runDirName } = await import('../run/sockets');
import type { DistroSh } from '../run/sockets';
import { HIRE, HIRE_B, crewDb } from './crew-db';

function fakeDistro(groups: string) {
  const scripts: string[] = [];
  const sh: DistroSh = async (script, root) => {
    scripts.push(`${root ? 'root' : 'crew'}: ${script}`);
    return script === RUN_GROUPS_SCRIPT ? { code: 0, stdout: groups, stderr: '' } : { code: 0, stdout: '', stderr: '' };
  };
  return { sh, scripts };
}

const sock = (runId: string, suffix = '') => `/tmp/cr-1000/${runDirName(runId)}${suffix}/gh`;

describe('Crew runs left in BodhiCrew by a Windows crash', () => {
  test('the unended runs are taken once and closed as interrupted', () => {
    const { raw, db } = crewDb();
    raw.query(`INSERT INTO crew_run (id, job_id, hire_id, pid) VALUES ('r1', 'j1', ?, 900)`).run(HIRE);
    raw.query(`INSERT INTO crew_run (id, job_id, hire_id, ended_at, outcome) VALUES ('r2', 'j2', ?, CURRENT_TIMESTAMP, 'done')`).run(HIRE);
    expect(takeLeftoverRuns(db)).toEqual([{ id: 'r1', jobId: 'j1', hireId: HIRE }]);
    expect(raw.query(`SELECT id, outcome, pid FROM crew_run ORDER BY id`).all()).toEqual([
      { id: 'r1', outcome: 'interrupted', pid: null }, { id: 'r2', outcome: 'done', pid: null },
    ]);
    expect(takeLeftoverRuns(db)).toEqual([]);
  });

  test("a leftover run's process group still alive is stopped as crew, with one audit row per run", async () => {
    const { raw, db } = crewDb();
    const d = fakeDistro(`4100 ${sock('r1')}\n4200 ${sock('r2', 'q')}\n4300 ${sock('other')}\n`);
    const stopped = await stopLeftoverWslRuns(db, d.sh, [
      { id: 'r1', jobId: 'j1', hireId: HIRE },
      { id: 'r2', jobId: 'j2', hireId: HIRE_B },
      { id: 'r3', jobId: 'j3', hireId: HIRE },
    ]);
    expect(stopped).toBe(2);
    expect(d.scripts[0]).toBe(`crew: ${RUN_GROUPS_SCRIPT}`);
    expect(d.scripts).toHaveLength(2);
    expect(d.scripts[1]).toStartWith('crew: ');
    expect(d.scripts[1]).toContain('kill -TERM -4100');
    expect(d.scripts[1]).toContain('kill -TERM -4200');
    expect(d.scripts[1]).toContain('kill -KILL -4100');
    expect(d.scripts[1]).not.toContain('4300');
    const audits = raw.query(`SELECT hire_id, event, detail FROM crew_audit WHERE event = 'run-leftover-stopped' ORDER BY id`).all() as { hire_id: string; detail: string }[];
    expect(audits.map((a) => [a.hire_id, JSON.parse(a.detail)])).toEqual([
      [HIRE, { runId: 'r1', jobId: 'j1', where: 'wsl' }],
      [HIRE_B, { runId: 'r2', jobId: 'j2', where: 'wsl' }],
    ]);
  });

  test('no live group, a garbled line or a failed listing stops nothing', async () => {
    const { raw, db } = crewDb();
    const runs = [{ id: 'r1', jobId: 'j1', hireId: HIRE }];
    const gone = fakeDistro(`1 ${sock('r1')}\nabc ${sock('r1')}\n4100\n`);
    expect(await stopLeftoverWslRuns(db, gone.sh, runs)).toBe(0);
    expect(gone.scripts).toHaveLength(1);
    const failing: DistroSh = async () => ({ code: 1, stdout: `4100 ${sock('r1')}\n`, stderr: 'no distro' });
    expect(await stopLeftoverWslRuns(db, failing, runs)).toBe(0);
    expect(await stopLeftoverWslRuns(db, gone.sh, [])).toBe(0);
    expect(raw.query(`SELECT COUNT(*) AS n FROM crew_audit WHERE event = 'run-leftover-stopped'`).get()).toEqual({ n: 0 });
  });

  test('the listing reads only process-group leaders and their CREW_GH_SOCKET', () => {
    expect(RUN_GROUPS_SCRIPT).toContain('/proc/[0-9]*');
    expect(RUN_GROUPS_SCRIPT).toContain('CREW_GH_SOCKET=');
    expect(RUN_GROUPS_SCRIPT).toContain('[ "$g" = "$p" ]');
  });
});
