/**
 * Spawn a cross-repo run's worktrees, then hand off to the per-owner machine
 * (CO-722).
 *
 * This is the last bootstrap step. The manifest is approved, so `cutWorktrees`
 * (TS — Phase 3) cuts one git worktree per in-scope repo (from `seams.yaml`'s
 * merge_order) off each repo's `origin/<integration_branch>`; then
 * `materializeOwners` writes the run's owner rows straight from those descriptors
 * -- the exact rows `armRun` writes for a harness-bootstrapped initiative. After
 * this the run is byte-for-byte what arming produces, and the driver's ordinary
 * provision -> gates 2/3/4 path takes over.
 *
 * Worktree cutting is now pure TS (`worktrees.ts`), so no Python is spawned here
 * and the team.yaml owners round-trip is gone: the TS cut is the source of truth.
 */
import * as path from 'path';
import type { RunRow } from '../repositories/runs';
import type { MaterializeRequest, MaterializeResult } from './ignition';
import type { WorktreeResult } from './worktrees';
import { mergeOrderFromSeams } from './arm-run';

export interface SpawnDeps {
  /** Cut (or resume) a worktree per repo, base branch resolved from the central config. */
  cut(initiative: string, repos: readonly string[], bodhiRoot: string): Promise<WorktreeResult>;
  readFile(p: string): string | null;
  materialize(request: MaterializeRequest): Promise<MaterializeResult>;
  log(line: string): void;
}

export type SpawnResult =
  | { status: 'spawned'; owners: Record<string, string> }
  | { status: 'refused'; reason: string };

/**
 * Cut the worktrees and write the owner rows, or say why a person is needed.
 * A refused cut (missing clone, origin mismatch) or a `>1-candidate` owner comes
 * back as a refusal; the caller parks the run inconclusive with it.
 */
export async function runSpawn(run: RunRow, deps: SpawnDeps): Promise<SpawnResult> {
  const seams = deps.readFile(path.join(run.initiativeDir, 'seams.yaml'));
  const mergeOrder = seams ? mergeOrderFromSeams(seams) : [];
  if (mergeOrder.length === 0) {
    return { status: 'refused', reason: 'seams.yaml names no repos to cut worktrees for' };
  }

  const cut = await deps.cut(run.initiativeKey, mergeOrder, run.bodhiRoot);
  if (cut.status === 'refused') {
    return { status: 'refused', reason: cut.reason };
  }

  const materialized = await deps.materialize({
    runId: run.id,
    initiativePath: run.initiativeDir,
    harnessPath: run.harnessPath,
    pythonPath: run.pythonPath ?? 'python',
    mergeOrder,
    worktrees: cut.owners,
  });
  if (materialized.status === 'refused') {
    return {
      status: 'refused',
      reason: materialized.refusals.map((r) => `${r.what} — ${r.fix}`).join('; '),
    };
  }
  deps.log(`${run.id}: spawned ${Object.keys(materialized.owners).length} owner(s); handing off`);
  return { status: 'spawned', owners: materialized.owners };
}
