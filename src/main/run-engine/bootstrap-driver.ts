/**
 * The cross-repo bootstrap sub-driver (CO-722).
 *
 * A `kind: 'multi'` run is driven here, OUTSIDE the pure per-owner machine in
 * `transitions.ts`, until its owners exist. The loop calls `driveBootstrap` once
 * per pass while `bootstrap_state` is set; each state does one durable step and
 * advances the column, so a restart resumes from wherever it stopped:
 *
 *   scoping        -> write team.yaml from the tester's repo picks (gate 0),
 *                     mechanically. -> architecting
 *   architecting   -> drive the `arch` gate to author seams.yaml (gate 1),
 *                     verify it, then evaluate the manifest: a sound one is
 *                     auto-approved straight to `spawning`; an anomalous one
 *                     parks at `awaitingManifest` for a person (CO-722 B2).
 *   awaitingManifest -> parked at runs.state 'waitingHumanGate' for a person to
 *                     approve. Only reached when the manifest looked off; the
 *                     loop skips it until approval flips it to spawning.
 *   spawning       -> spawn.py cuts the worktrees and materializes owners, then
 *                     hands off to the per-owner machine.
 *
 * This module holds no Electron or DB imports: the writes go through an injected
 * store and the scripts through an injected io, so the whole sequence is
 * testable dry.
 */
import type { RunRow } from '../repositories/runs';
import type { RunState } from './transitions';
import type { BootstrapState } from './bootstrap';
import { scopeInitiative, type ScopeIo } from './scope-initiative';
import type { ArchResult } from './bootstrap-arch';
import type { SpawnResult } from './bootstrap-spawn';
import type { ManifestAnomaly } from './manifest-anomaly';

/** The run-level writes the bootstrap makes, injected (real ones are the repo). */
export interface BootstrapStore {
  setBootstrapState(runId: string, state: BootstrapState | null): void;
  setRunState(runId: string, state: RunState, blockedReason?: string | null): void;
  /** Park the run for a person, with the reason the inbox shows, and record the event. */
  recordInconclusive(runId: string, reason: string, gate: number): void;
  appendEvent(runId: string, kind: string, gate?: number): void;
}

export interface BootstrapDeps {
  io: ScopeIo;
  store: BootstrapStore;
  /** Drive gate 1 (arch): author + verify the seam manifest, or say why not. */
  arch(run: RunRow): Promise<ArchResult>;
  /**
   * Judge whether the parked manifest can be auto-approved, or name why a person
   * is needed. Runs against the seams.yaml arch just wrote (CO-722 B2).
   */
  evaluateManifest(run: RunRow): ManifestAnomaly;
  /** Cut the worktrees and write the owner rows, or say why not. */
  spawn(run: RunRow): Promise<SpawnResult>;
  log(line: string): void;
}

/** One bootstrap pass: whether it did work, and any problems for the tick report. */
export interface BootstrapPassResult {
  drove: boolean;
  problems: string[];
}

const IDLE: BootstrapPassResult = { drove: false, problems: [] };

/**
 * Drive one bootstrap step for a multi run. Returns quietly (`drove: false`) for
 * a state this slice does not yet implement or one the loop should not have
 * routed here (`done`, or a null sub-state) -- never a problem, so an
 * unimplemented state is a benign hold, not a backoff.
 */
export async function driveBootstrap(run: RunRow, deps: BootstrapDeps): Promise<BootstrapPassResult> {
  switch (run.bootstrapState) {
    case 'scoping':
      return scope(run, deps);
    case 'architecting':
      return architect(run, deps);
    case 'spawning':
      return spawnStep(run, deps);
    // awaitingManifest parks at runs.state 'waitingHumanGate' (a person, not the
    // loop); approval flips it to spawning. `done` should never reach here (the
    // handoff clears the column to null). Benign holds either way.
    case 'awaitingManifest':
    case 'done':
    case null:
    case undefined:
      return IDLE;
    default:
      return IDLE;
  }
}

/** Gate 0: write team.yaml from the picks, then advance to the arch gate. */
async function scope(run: RunRow, deps: BootstrapDeps): Promise<BootstrapPassResult> {
  const scoped = await scopeInitiative(run, deps.io);
  if (scoped.status === 'refused') {
    deps.store.recordInconclusive(run.id, scoped.reason, 0);
    deps.log(`${run.id}: scope refused -- ${scoped.reason}`);
    return { drove: true, problems: [scoped.reason] };
  }
  deps.store.appendEvent(run.id, 'scoped', 0);
  deps.store.setBootstrapState(run.id, 'architecting');
  deps.log(`${run.id}: scoped ${(run.scopeRepos ?? []).join(', ')}; arch next`);
  return { drove: true, problems: [] };
}

/** Gate 1: drive arch, then either park for approval or park inconclusive. */
async function architect(run: RunRow, deps: BootstrapDeps): Promise<BootstrapPassResult> {
  const result = await deps.arch(run);
  if (result.status === 'inconclusive') {
    deps.store.recordInconclusive(run.id, result.reason, 1);
    deps.log(`${run.id}: arch inconclusive -- ${result.reason}`);
    return { drove: true, problems: [result.reason] };
  }
  deps.store.appendEvent(run.id, 'archManifest', 1);

  // Auto-approve a sound manifest so an otherwise hands-off run does not stop
  // for a click; hold only when something looks off (CO-722 B2). The anomaly
  // check is narrow -- arch already ran the harness's deep verifier -- so a
  // hold here means a policy problem a person should see, not a structural one.
  const anomaly = deps.evaluateManifest(run);
  if (!anomaly.ok) {
    deps.store.setBootstrapState(run.id, 'awaitingManifest');
    // Park for a person, with the reason on the run so the inbox says WHY it is
    // held. waitingHumanGate is not movable, so the loop stops polling this run
    // until approval (or rejection) flips it.
    deps.store.setRunState(run.id, 'waitingHumanGate', anomaly.reason);
    deps.store.appendEvent(run.id, 'manifestHeldForReview', 1);
    deps.log(`${run.id}: seam manifest held for review -- ${anomaly.reason}`);
    return { drove: true, problems: [] };
  }

  // Clean: release straight to spawn, mirroring approveRunManifest's transition
  // (spawning + preparing) so the loop re-picks the run and the spawn step runs.
  deps.store.appendEvent(run.id, 'manifestAutoApproved', 1);
  deps.store.setBootstrapState(run.id, 'spawning');
  deps.store.setRunState(run.id, 'preparing');
  deps.log(`${run.id}: seam manifest auto-approved; spawning next`);
  return { drove: true, problems: [] };
}

/**
 * Gate 2 setup: cut the worktrees, write the owner rows, then hand off. Clearing
 * `bootstrap_state` and dropping to `preparing` is the handoff -- the next pass
 * sees owners + preparing and the per-owner machine provisions and drives.
 */
async function spawnStep(run: RunRow, deps: BootstrapDeps): Promise<BootstrapPassResult> {
  const result = await deps.spawn(run);
  if (result.status === 'refused') {
    deps.store.recordInconclusive(run.id, result.reason, 2);
    deps.log(`${run.id}: spawn refused -- ${result.reason}`);
    return { drove: true, problems: [result.reason] };
  }
  deps.store.appendEvent(run.id, 'spawned', 2);
  deps.store.setBootstrapState(run.id, null);
  deps.store.setRunState(run.id, 'preparing');
  deps.log(`${run.id}: handed off to the per-owner machine`);
  return { drove: true, problems: [] };
}
