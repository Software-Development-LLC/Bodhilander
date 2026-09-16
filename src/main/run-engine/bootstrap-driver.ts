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
 *                     verify + publish it. -> awaitingManifest        [slice 3]
 *   awaitingManifest -> parked at runs.state 'waitingHumanGate' for a person to
 *                     approve. Not driven here; the loop skips it.      [slice 4]
 *   spawning       -> spawn.py cuts the worktrees and materializes owners, then
 *                     hands off to the per-owner machine.               [slice 4]
 *
 * This module holds no Electron or DB imports: the writes go through an injected
 * store and the scripts through an injected io, so the whole sequence is
 * testable dry.
 */
import type { RunRow } from '../repositories/runs';
import type { RunState } from './transitions';
import type { BootstrapState } from './bootstrap';
import { scopeInitiative, type ScopeIo } from './scope-initiative';

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
    // Filled by later slices; until then a multi run simply holds here.
    case 'architecting':
    case 'awaitingManifest':
    case 'spawning':
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
