/**
 * Spawn a cross-repo run's worktrees, then hand off to the per-owner machine
 * (CO-722).
 *
 * This is the last bootstrap step. The manifest is approved, so `spawn.py` cuts
 * one git worktree per in-scope repo (from `seams.yaml`'s merge_order plus every
 * seam's producer/consumer) and fills team.yaml's owners block; then
 * `materializeOwners` reads that block back and writes the run's owner rows --
 * the exact rows `armRun` writes for a harness-bootstrapped initiative. After
 * this the run is byte-for-byte what arming produces, and the driver's ordinary
 * provision -> gates 2/3/4 path takes over.
 *
 * `spawn.py` is invoked exactly as single-repo prepare invokes it (the python
 * interpreter against the library file, BODHI_ROOT set), because Windows cannot
 * spawn the `.sh` wrapper without a shell.
 */
import * as path from 'path';
import type { RunRow } from '../repositories/runs';
import type { CommandOutput } from './prepare-initiative';
import type { MaterializeRequest, MaterializeResult } from './ignition';
import { mergeOrderFromSeams } from './arm-run';

export interface SpawnDeps {
  run(exe: string, argv: readonly string[], opts: { env?: Record<string, string> }): Promise<CommandOutput>;
  readFile(p: string): string | null;
  materialize(request: MaterializeRequest): Promise<MaterializeResult>;
  log(line: string): void;
}

export type SpawnResult =
  | { status: 'spawned'; owners: Record<string, string> }
  | { status: 'refused'; reason: string };

/**
 * Cut the worktrees and write the owner rows, or say why a person is needed.
 * A `>1-candidate` repo comes back as the same refusal arming gives; the caller
 * parks the run inconclusive with it.
 */
export async function runSpawn(run: RunRow, deps: SpawnDeps): Promise<SpawnResult> {
  const spawn = await deps.run(
    run.pythonPath ?? 'python',
    [path.join(run.harnessPath, 'scripts', 'lib', 'spawn.py'), run.initiativeDir],
    // Only BODHI_ROOT is named; runCommand merges it over the parent env so
    // PATH, HOME and git's own environment still reach spawn.py.
    { env: { BODHI_ROOT: run.bodhiRoot } },
  );
  if (spawn.code !== 0) {
    return {
      status: 'refused',
      reason: firstLine(spawn.stderr, spawn.stdout) ?? 'spawn.py could not cut the worktrees',
    };
  }

  const seams = deps.readFile(path.join(run.initiativeDir, 'seams.yaml'));
  const mergeOrder = seams ? mergeOrderFromSeams(seams) : [];
  const materialized = await deps.materialize({
    runId: run.id,
    initiativePath: run.initiativeDir,
    harnessPath: run.harnessPath,
    pythonPath: run.pythonPath ?? 'python',
    mergeOrder,
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

/** The first non-empty line across the given texts, for a one-line reason. */
function firstLine(...texts: string[]): string | null {
  for (const text of texts) {
    const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (line) return line;
  }
  return null;
}
