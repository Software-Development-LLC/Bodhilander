/**
 * Spawn + handoff for a cross-repo run (CO-722).
 *
 * The properties that matter: spawn.py is run with BODHI_ROOT set, the merge
 * order is read from seams.yaml and passed to materializeOwners, a spawn failure
 * is a one-line reason (not a throw), and a >1-candidate owner surfaces the same
 * refusal arming gives rather than guessing.
 *
 * Run with: bun test src/main/run-engine/__tests__/bootstrap-spawn.test.ts
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import type { RunRow } from '../../repositories/runs';
import type { CommandOutput } from '../prepare-initiative';
import type { MaterializeRequest, MaterializeResult } from '../ignition';
import { runSpawn, type SpawnDeps } from '../bootstrap-spawn';

function run(): RunRow {
  return {
    id: 'r1', initiativeKey: 'BWA-4764', initiativeDir: path.join('C:/root/initiatives', 'BWA-4764'),
    harnessPath: 'C:/h', bodhiRoot: 'C:/root', pythonPath: 'py', state: 'preparing',
    permissionPosture: 'manual', budgetUsd: null, groupId: null, blockedReason: null,
    kind: 'multi', bootstrapState: 'spawning', scopeRepos: ['a', 'b'],
    createdAt: new Date(), updatedAt: new Date(),
  } as RunRow;
}

interface Rec {
  runs: { exe: string; argv: readonly string[]; env?: Record<string, string> }[];
  materializeReqs: MaterializeRequest[];
}

function harness(opts: {
  spawnCode?: number; spawnStderr?: string; seams?: string | null; materialize?: MaterializeResult;
} = {}): { deps: SpawnDeps; rec: Rec } {
  const rec: Rec = { runs: [], materializeReqs: [] };
  const deps: SpawnDeps = {
    run: async (exe, argv, o): Promise<CommandOutput> => {
      rec.runs.push({ exe, argv, env: o.env });
      return { code: opts.spawnCode ?? 0, stdout: '', stderr: opts.spawnStderr ?? '' };
    },
    readFile: () => (opts.seams === undefined ? 'merge_order: [a, b]\nseams: []\n' : opts.seams),
    materialize: async (request): Promise<MaterializeResult> => {
      rec.materializeReqs.push(request);
      return opts.materialize ?? { status: 'materialized', owners: { a: 'lead', b: 'lead2' }, mergeOrder: ['a', 'b'] };
    },
    log: () => {},
  };
  return { deps, rec };
}

describe('runSpawn', () => {
  test('runs spawn.py with BODHI_ROOT, then materializes owners with the merge order', async () => {
    const { deps, rec } = harness();
    const result = await runSpawn(run(), deps);
    expect(result).toEqual({ status: 'spawned', owners: { a: 'lead', b: 'lead2' } });

    expect(rec.runs).toHaveLength(1);
    expect(rec.runs[0].exe).toBe('py');
    expect(rec.runs[0].argv[0]).toBe(path.join('C:/h', 'scripts', 'lib', 'spawn.py'));
    expect(rec.runs[0].argv[1]).toBe(path.join('C:/root/initiatives', 'BWA-4764'));
    expect(rec.runs[0].env).toEqual({ BODHI_ROOT: 'C:/root' });

    // The merge order arch wrote is read from seams.yaml and threaded through.
    expect(rec.materializeReqs).toHaveLength(1);
    expect(rec.materializeReqs[0].mergeOrder).toEqual(['a', 'b']);
    expect(rec.materializeReqs[0].runId).toBe('r1');
  });

  test('a spawn.py failure is a one-line reason, and owners are never materialized', async () => {
    const { deps, rec } = harness({ spawnCode: 1, spawnStderr: 'spawn: repo bodhi-x is not cloned under BODHI_ROOT\ntrace' });
    const result = await runSpawn(run(), deps);
    expect(result).toEqual({ status: 'refused', reason: 'spawn: repo bodhi-x is not cloned under BODHI_ROOT' });
    expect(rec.materializeReqs).toHaveLength(0);
  });

  test('a >1-candidate owner surfaces the refusal, joined into a reason', async () => {
    const { deps } = harness({
      materialize: { status: 'refused', refusals: [{ what: 'repo-b has 2 possible owners', fix: 'Name one for this run: lead, domain' }] },
    });
    const result = await runSpawn(run(), deps);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.reason).toBe('repo-b has 2 possible owners — Name one for this run: lead, domain');
  });

  test('an absent seams.yaml is a merge order of none, not a crash', async () => {
    const { deps, rec } = harness({ seams: null });
    const result = await runSpawn(run(), deps);
    expect(result.status).toBe('spawned');
    expect(rec.materializeReqs[0].mergeOrder).toEqual([]);
  });
});
