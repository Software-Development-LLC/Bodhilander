/**
 * Spawn + handoff for a cross-repo run (CO-722, Phase 3 — TS worktrees).
 *
 * The properties that matter: the repo list is read from seams.yaml's merge
 * order and cut in TS, the cut owners are threaded to materializeOwners as
 * `worktrees`, a refused cut (or a >1-candidate owner) is a one-line reason (not
 * a throw), and no repos to cut is a refusal rather than a silent no-op.
 *
 * Run with: bun test src/main/run-engine/__tests__/bootstrap-spawn.test.ts
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import type { RunRow } from '../../repositories/runs';
import type { MaterializeRequest, MaterializeResult } from '../ignition';
import type { WorktreeResult } from '../worktrees';
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
  cuts: { initiative: string; repos: string[]; bodhiRoot: string }[];
  materializeReqs: MaterializeRequest[];
}

const OWNERS: Extract<WorktreeResult, { status: 'ok' }>['owners'] = {
  a: { worktree: 'C:/root/_wt-bwa-4764-a', branch: 'feat/BWA-4764-a', base: 'development', scratch: 'C:/root/_wt-bwa-4764-a-scratch' },
  b: { worktree: 'C:/root/_wt-bwa-4764-b', branch: 'feat/BWA-4764-b', base: 'main', scratch: 'C:/root/_wt-bwa-4764-b-scratch' },
};

function harness(opts: {
  cut?: WorktreeResult; seams?: string | null; materialize?: MaterializeResult;
  configOwners?: Record<string, string>;
} = {}): { deps: SpawnDeps; rec: Rec } {
  const rec: Rec = { cuts: [], materializeReqs: [] };
  const deps: SpawnDeps = {
    cut: async (initiative, repos, bodhiRoot): Promise<WorktreeResult> => {
      rec.cuts.push({ initiative, repos: [...repos], bodhiRoot });
      return opts.cut ?? { status: 'ok', owners: OWNERS };
    },
    configOwners: async () => opts.configOwners ?? {},
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
  test('cuts the merge-order repos in TS, then materializes owners from the cut worktrees', async () => {
    const { deps, rec } = harness();
    const result = await runSpawn(run(), deps);
    expect(result).toEqual({ status: 'spawned', owners: { a: 'lead', b: 'lead2' } });

    expect(rec.cuts).toEqual([{ initiative: 'BWA-4764', repos: ['a', 'b'], bodhiRoot: 'C:/root' }]);

    // The merge order arch wrote is threaded through, and the cut worktrees are
    // handed to materialize directly (no team.yaml round-trip).
    expect(rec.materializeReqs).toHaveLength(1);
    expect(rec.materializeReqs[0].mergeOrder).toEqual(['a', 'b']);
    expect(rec.materializeReqs[0].runId).toBe('r1');
    expect(rec.materializeReqs[0].worktrees).toBe(OWNERS);
  });

  test('config-named owners are passed to materialize to disambiguate resolution', async () => {
    const { deps, rec } = harness({ configOwners: { a: 'bsa-lead' } });
    await runSpawn(run(), deps);
    // Only repos the config names appear; the rest resolve from the harness.
    expect(rec.materializeReqs[0].owners).toEqual({ a: 'bsa-lead' });
  });

  test('a refused cut is a one-line reason, and owners are never materialized', async () => {
    const { deps, rec } = harness({ cut: { status: 'refused', reason: 'bodhi-x: clone not present in BODHI_ROOT (C:/root/bodhi-x)' } });
    const result = await runSpawn(run(), deps);
    expect(result).toEqual({ status: 'refused', reason: 'bodhi-x: clone not present in BODHI_ROOT (C:/root/bodhi-x)' });
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

  test('no repos to cut (absent seams.yaml) is a refusal, not a silent no-op', async () => {
    const { deps, rec } = harness({ seams: null });
    const result = await runSpawn(run(), deps);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.reason).toContain('no repos');
    expect(rec.cuts).toHaveLength(0);
  });
});
