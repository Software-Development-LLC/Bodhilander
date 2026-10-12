/**
 * Shared vocabulary for the in-app cross-repo bootstrap (CO-722).
 *
 * A cross-repo initiative can't be armed the way a single-repo one is: its
 * owners don't exist until the `arch` agent has authored the seam manifest and
 * `spawn.py` has cut a worktree per repo. So a `kind: 'multi'` run is created
 * with NO owners and driven through a small pre-owner state machine -- its
 * `bootstrap_state` -- entirely OUTSIDE the pure per-owner machine in
 * `transitions.ts`, which stays untouched. Once `spawn.py` materializes the
 * owners the run is byte-for-byte what `armRun` produces (`state: 'preparing'`,
 * owner rows with a null gate state) and the existing provision -> gates 2/3/4
 * path takes over.
 *
 * These three declarations are the contract the driver, the repository and the
 * renderer share; they live here (not in `transitions.ts`) precisely so the
 * pure machine does not learn about the bootstrap.
 */

/** `'single'` = the existing arm-and-drive path; `'multi'` = cross-repo bootstrap. */
export type RunKind = 'single' | 'multi';

/**
 * The pre-owner bootstrap sub-state, on `runs.bootstrap_state` (null for single
 * runs). Linear: `scoping` writes team.yaml mechanically from the tester's repo
 * picks; `architecting` drives the `arch` gate to author seams.yaml;
 * `awaitingManifest` parks for a person to approve the manifest; `spawning` cuts
 * the worktrees and materializes owners; `done` hands off to the per-owner
 * machine.
 */
export type BootstrapState =
  | 'scoping'
  | 'architecting'
  | 'awaitingManifest'
  | 'spawning'
  | 'done';

/**
 * The sentinel `repo` for the pre-owner `arch` gate (gate 1). No real owner
 * exists yet, but `run_gates`, `channelKeyFor` and `activeGate` are all keyed on
 * a repo string, so the arch gate borrows this one -- distinct from any real
 * repo slug so it can never collide -- and its permission prompts flow through
 * the same broker as owner gates.
 */
export const SCOPE_REPO = '(scope)';
