/**
 * Ignition tests (CO-722).
 *
 * Almost every test here is about a run that does NOT start, because that is
 * almost all of what this module does. The design's rule is that half a
 * working orchestrator is worse than none: a run that starts without a Python
 * it can drive fails four gates in, having cut worktrees and spent tokens,
 * with a message about whatever broke first.
 *
 * A real database and a real harness on disk; only the commands are faked.
 *
 * Run with: bun test src/main/run-engine
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

let db: Database;

mock.module('../../database', () => ({ getDatabase: () => db }));

const runs = await import('../../repositories/runs');
const { RUN_TABLES_SQL } = await import('../../run-tables-sql');
const { armRun } = await import('../ignition');
import type { IgnitionDeps, IgnitionRequest } from '../ignition';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);');
  db.exec(RUN_TABLES_SQL);
});

/** A harness whose staff agents declare the repos they own. */
async function harness(staff: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-'));
  made.push(root);
  await fs.mkdir(path.join(root, 'agents', 'staff'), { recursive: true });
  for (const [name, repo] of Object.entries(staff)) {
    const front = ['---', `name: ${name}`, `repo: ${repo}`, 'tools: Read, Write, Bash', '---', '', '# Purpose', ''];
    await fs.writeFile(path.join(root, 'agents', 'staff', `${name}.md`), front.join('\n'));
  }
  return root;
}

const OWNERS = {
  'demo-repo': {
    worktree: 'C:/work/repos/_wt-ig-1',
    branch: 'feat/IG-1-thing',
    base: 'origin/development',
    scratch: 'C:/work/repos/_wt-ig-1-scratch',
  },
};

interface Answer {
  code: number;
  stdout: string;
  stderr: string;
}

const OK: Answer = { code: 0, stdout: '', stderr: '' };

function fake(options: { python?: Answer; gh?: Answer; initiative?: Answer } = {}): IgnitionDeps {
  return {
    run: async (executable, argv) => {
      if (argv.some((a) => a.includes('initiative.py'))) {
        const found = { code: 0, stdout: JSON.stringify({ initiative: 'IG-1', owners: OWNERS }), stderr: '' };
        return options.initiative ?? found;
      }
      if (executable.includes('gh')) return options.gh ?? OK;
      return options.python ?? OK;
    },
  };
}

async function request(over: Partial<IgnitionRequest> = {}): Promise<IgnitionRequest> {
  return {
    initiativePath: 'C:/work/initiatives/IG-1',
    harnessPath: await harness({ 'demo-lead': 'demo-repo' }),
    bodhiRoot: 'C:/work/repos',
    pythonPath: 'C:/py/python.exe',
    ghPath: 'gh',
    posture: 'manual',
    ...over,
  };
}

describe('a run that starts', () => {
  test('is armed, with its owners recorded', async () => {
    const result = await armRun(await request(), fake());
    expect(result.status).toBe('armed');
    if (result.status !== 'armed') throw new Error('unreachable');
    expect(result.initiativeKey).toBe('IG-1');
    expect(result.owners).toEqual({ 'demo-repo': 'demo-lead' });

    const owners = runs.listOwners(result.runId);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      repo: 'demo-repo',
      worktree: 'C:/work/repos/_wt-ig-1',
      base: 'origin/development',
    });
  });

  test('and is armed, not started', async () => {
    // Nothing has been cut, launched or pushed. Starting is somebody saying
    // go, and it is the first irreversible thing this system does.
    const result = await armRun(await request(), fake());
    if (result.status !== 'armed') throw new Error('unreachable');
    expect(runs.getRun(result.runId)?.state).toBe('preparing');
    expect(runs.listEvents(result.runId)).toEqual([]);
    expect(runs.listGates(result.runId)).toEqual([]);
  });
});

describe('a run that does not start', () => {
  test('a python that does not RUN is refused, however good its name', async () => {
    // `command -v python3` passes on a WindowsApps alias that exits non-zero
    // with a Store advertisement. It is on PATH and it is not Python.
    const result = await armRun(await request(), fake({
      python: { code: 9009, stdout: '', stderr: 'Microsoft Store' },
    }));
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.refusals[0].what).toContain('did not run');
    expect(result.refusals[0].fix).toContain('Store alias');
  });

  test('a missing gh is refused', async () => {
    const result = await armRun(await request(), fake({
      gh: { code: 127, stdout: '', stderr: 'not found' },
    }));
    if (result.status !== 'refused') throw new Error('expected refusal');
    expect(result.refusals.some((r) => r.what.includes('gh'))).toBe(true);
  });

  test('every problem is reported, not just the first', async () => {
    // A person fixing a machine wants the whole list. One at a time is three
    // round trips for one problem.
    const result = await armRun(await request(), fake({
      python: { code: 1, stdout: '', stderr: '' },
      gh: { code: 127, stdout: '', stderr: '' },
    }));
    if (result.status !== 'refused') throw new Error('expected refusal');
    expect(result.refusals).toHaveLength(2);
  });

  test('an initiative nobody has started is refused in the plugin own words', async () => {
    // It knows whether this is a directory nobody started or one whose owners
    // spawn.sh has not filled in yet, and those have different answers.
    const result = await armRun(await request(), fake({
      initiative: {
        code: 2,
        stdout: JSON.stringify({ owners: {}, detail: 'no team.yaml at ...' }),
        stderr: '',
      },
    }));
    if (result.status !== 'refused') throw new Error('expected refusal');
    expect(result.refusals[0].fix).toContain('no team.yaml');
  });

  test('owners not cut yet is refused too, and says so differently', async () => {
    const result = await armRun(await request(), fake({
      initiative: {
        code: 3,
        stdout: JSON.stringify({ owners: {}, detail: 'spawn.sh fills it when it cuts them' }),
        stderr: '',
      },
    }));
    if (result.status !== 'refused') throw new Error('expected refusal');
    expect(result.refusals[0].fix).toContain('spawn.sh');
  });

  test('nothing is written when a run is refused', async () => {
    // THE property. A half-written run is worse than none: it appears in
    // every list, and the next thing to look at it has no idea it never
    // passed a check.
    await armRun(await request(), fake({ python: { code: 1, stdout: '', stderr: '' } }));
    expect(runs.listActiveRuns()).toEqual([]);
  });
});

describe('who owns gate 2 is discovered, and never guessed', () => {
  test('one candidate decides it', async () => {
    const result = await armRun(await request(), fake());
    if (result.status !== 'armed') throw new Error('unreachable');
    expect(result.owners['demo-repo']).toBe('demo-lead');
  });

  test('several candidates is a question, not a coin toss', async () => {
    // A lead owns what cuts across a repo; domain owners own their modules.
    // Picking wrong is an agent editing a module that is not theirs.
    const harnessPath = await harness({ 'demo-lead': 'demo-repo', 'demo-care': 'demo-repo' });
    const result = await armRun(await request({ harnessPath }), fake());
    if (result.status !== 'refused') throw new Error('expected refusal');
    expect(result.refusals[0].what).toContain('2 possible owners');
    expect(result.refusals[0].fix).toContain('demo-care, demo-lead');
  });

  test('and naming one answers it', async () => {
    const harnessPath = await harness({ 'demo-lead': 'demo-repo', 'demo-care': 'demo-repo' });
    const result = await armRun(
      await request({ harnessPath, owners: { 'demo-repo': 'demo-care' } }),
      fake(),
    );
    if (result.status !== 'armed') throw new Error('expected armed');
    expect(result.owners['demo-repo']).toBe('demo-care');
  });

  test('a name that does not own the repo is refused', async () => {
    // Naming one is a choice between candidates, not a way past the check.
    const result = await armRun(
      await request({ owners: { 'demo-repo': 'somebody-else' } }),
      fake(),
    );
    if (result.status !== 'refused') throw new Error('expected refusal');
    expect(result.refusals[0].what).toContain('does not own');
  });

  test('a repo nobody owns is refused', async () => {
    const harnessPath = await harness({ 'other-lead': 'a-different-repo' });
    const result = await armRun(await request({ harnessPath }), fake());
    if (result.status !== 'refused') throw new Error('expected refusal');
    expect(result.refusals[0].what).toContain('no agent in this harness declares');
  });
});
