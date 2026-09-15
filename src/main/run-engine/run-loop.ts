/**
 * The thing that calls the engine without a person (CO-722).
 *
 * Every function this calls existed before it did. `advance` moves a run;
 * `lookAtGate` says what a launched gate has become; `reconcileOnce` reads a
 * PR; the cadences in `reconcile-loop.ts` say how often each is owed. What
 * did not exist was anything that called them on a timer, which is why every
 * run to date advanced because someone typed `step`, `watch` or `answer`
 * into a console -- and "you are still the dispatcher" was one of the three
 * pains this engine was built to end.
 *
 * ## What a tick does
 *
 * For each active run that is due -- by `dueRuns`, so a run never looked at
 * is due now and a run that failed last time waits longer:
 *
 *   running                          look at the gate in flight; apply what
 *                                    `attend` decides, if anything
 *   waitingChecks / waitingReview /  find the PR if the run does not know it
 *   reviewNotRequested               yet, then reconcile against GitHub and
 *                                    apply every event that came back
 *
 * Nothing else is due, by construction: `intervalFor` returns null for a
 * run waiting on a person or already finished, and asking again cannot
 * unstick either.
 *
 * ## What this does not do
 *
 * It does not spawn anything itself -- `advance` does, through the same
 * `spawnGate` the console uses. It does not decide anything about a gate or
 * a PR -- `attend` and `reconcileOnce` do. It does not answer permissions;
 * that is a person, through the channel. It keeps the schedule, and it says
 * what it did.
 *
 * Every dependency is injected, because a scheduler is the one part of an
 * engine that cannot be unit-tested against the real thing without waiting.
 */
import type { RunGateRow, RunOwnerRow, RunRow } from '../repositories/runs';
import type { AdvanceResult } from './driver';
import type { GateLook } from './attention-pass';
import type { DiscoveredPr } from './pr-discovery';
import { repoSlugFromUrl } from './pr-discovery';
import type { ReconcileResult, ReconcileTarget } from './reconcile';
import { dueRuns, shouldEscalate, type ScheduledRun } from './reconcile-loop';
import type { RunEvent, RunState } from './transitions';

export interface LoopDeps {
  now(): number;
  listActiveRuns(): RunRow[];
  listOwners(runId: string): RunOwnerRow[];
  activeGate(runId: string): RunGateRow | null;
  /** The gathering half of #287. */
  look(run: RunRow, gate: RunGateRow): Promise<GateLook>;
  /**
   * Permission requests waiting in this gate's channel (#288).
   *
   * A background gate blocked on a tool reads `busy`, not `waiting`, because
   * its hook is running; the request file is the only evidence a person is
   * needed. So this is checked before the attention decision, and any
   * pending request moves the run to waitingPermission where status could
   * not.
   */
  pending(run: RunRow, gate: RunGateRow): number;
  /** `gh pr list --head <branch>` in the owner's worktree. */
  discoverPr(run: RunRow, owner: RunOwnerRow): Promise<DiscoveredPr | null>;
  recordPr(run: RunRow, owner: RunOwnerRow, pr: DiscoveredPr): void;
  reconcile(run: RunRow, target: ReconcileTarget): Promise<ReconcileResult>;
  /** The driver, with this run's real spawner behind it. */
  advance(run: RunRow, event: RunEvent): Promise<AdvanceResult>;
  approvers(): readonly string[];
  log(line: string): void;
}

/** What one tick did, for the caller to print or test. */
export interface TickReport {
  at: number;
  /** Runs that were due. */
  due: string[];
  looked: { runId: string; gate: number; agent: string; decided: string | null }[];
  reconciled: { runId: string; events: string[] }[];
  /** Due, but nothing could be done, and why. Counted as a failure for backoff. */
  skipped: { runId: string; why: string }[];
  problems: { runId: string; problem: string }[];
  /** Runs whose consecutive failures just reached the threshold. */
  escalated: string[];
}

/** The states a tick reconciles against GitHub. Everything else is a gate or a person. */
export const RECONCILES: ReadonlySet<RunState> = new Set(['waitingChecks', 'waitingReview', 'reviewNotRequested']);

/** A run a loop can still move without a person: a running gate, or a reconcile. */
export function isMovable(state: RunState): boolean {
  return state === 'running' || RECONCILES.has(state);
}

export interface RunLoop {
  /** One pass over every due run. Never rejects; problems are reported. */
  tick(): Promise<TickReport>;
  /** Tick every `everyMs`, skipping a tick while one is still running. */
  start(everyMs: number): void;
  stop(): void;
  /** What the loop remembers about each run. For status displays and tests. */
  schedule(): ReadonlyMap<string, ScheduledRun>;
}

export function createRunLoop(deps: LoopDeps): RunLoop {
  const memory = new Map<string, ScheduledRun>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  function remember(run: RunRow): ScheduledRun {
    const known = memory.get(run.id);
    // The state is the database's, always; only the bookkeeping is ours.
    const next: ScheduledRun = known
      ? { ...known, state: run.state }
      : { id: run.id, state: run.state, lastPassAt: null, failures: 0 };
    memory.set(run.id, next);
    return next;
  }

  function passed(runId: string, ok: boolean, report: TickReport): void {
    const s = memory.get(runId);
    if (!s) return;
    const failures = ok ? 0 : s.failures + 1;
    memory.set(runId, { ...s, lastPassAt: deps.now(), failures });
    if (!ok && shouldEscalate(failures)) report.escalated.push(runId);
  }

  async function lookAt(run: RunRow, report: TickReport): Promise<boolean> {
    const gate = deps.activeGate(run.id);
    if (!gate) {
      report.skipped.push({ runId: run.id, why: 'running with no gate row open' });
      return false;
    }
    // A pending permission request means a person is needed, whatever the
    // daemon says the session is doing: the hook holds the tool, so the gate
    // reads busy while it is in fact blocked. This takes precedence over the
    // attention decision, and moves the run to waitingPermission -- out of
    // the loop's reach and into the inbox -- until the request is answered.
    if (deps.pending(run, gate) > 0) {
      const result = await deps.advance(run, { kind: 'permissionRequested' });
      for (const problem of result.problems) report.problems.push({ runId: run.id, problem });
      report.looked.push({ runId: run.id, gate: gate.gate, agent: gate.agent, decided: 'permissionRequested' });
      deps.log(`${run.id} gate ${gate.gate} (${gate.agent}) is waiting on a person for permission`);
      return result.problems.length === 0;
    }
    const look = await deps.look(run, gate);
    report.looked.push({ runId: run.id, gate: look.gate, agent: look.agent, decided: look.attention.event?.kind ?? null });
    if (look.attention.note) deps.log(`${run.id} ${look.attention.note}`);
    if (look.attention.event) {
      const result = await deps.advance(run, look.attention.event);
      for (const problem of result.problems) report.problems.push({ runId: run.id, problem });
      return result.problems.length === 0;
    }
    return true;
  }

  async function reconcileRun(run: RunRow, report: TickReport): Promise<boolean> {
    const owners = deps.listOwners(run.id);
    if (owners.length === 0) {
      report.skipped.push({ runId: run.id, why: 'no owner recorded, so no branch to find a PR for' });
      return false;
    }
    if (owners.length > 1) {
      // The gate-2 role is held per gate, not per repo, so a multi-owner run
      // is out of this slice's scope. Reconciling only the first owner's PR
      // would look like progress while the others went unwatched, so it is a
      // skip a person can see rather than a silent single-repo pass.
      report.skipped.push({
        runId: run.id,
        why: `${owners.length} owners (${owners.map((o) => o.repo).join(', ')}); this slice drives one repo`,
      });
      return false;
    }
    const owner = owners[0];
    if (owner.prNumber === null || !owner.prUrl) {
      // The scribe opened it; nothing told us which. The branch is the one
      // thing the run knows, and gh can find the PR from it.
      const pr = await deps.discoverPr(run, owner);
      if (!pr) {
        report.skipped.push({ runId: run.id, why: `no PR found for ${owner.repo} branch ${owner.branch} yet` });
        return false;
      }
      deps.recordPr(run, owner, pr);
      owner.prNumber = pr.number;
      owner.prUrl = pr.url;
      deps.log(`${run.id} ${owner.repo}: PR #${pr.number} found for ${owner.branch}`);
    }
    const repo = repoSlugFromUrl(owner.prUrl ?? '');
    if (!repo) {
      report.skipped.push({ runId: run.id, why: `the recorded PR URL ${owner.prUrl} does not name a repository` });
      return false;
    }
    // A local, so the type narrows without a cast: owner is mutable (the
    // discovery branch above sets prNumber on it), so TypeScript will not
    // carry the narrowing across that write on its own.
    const prNumber = owner.prNumber;
    if (prNumber === null) {
      report.skipped.push({ runId: run.id, why: 'a PR number was expected by now but is not recorded' });
      return false;
    }
    const result = await deps.reconcile(run, {
      repo,
      registryRepo: owner.repo,
      prNumber,
      state: run.state,
      approvers: deps.approvers(),
      harnessPath: run.harnessPath,
      pythonPath: run.pythonPath ?? 'python',
    });
    for (const problem of result.problems) report.problems.push({ runId: run.id, problem });
    const applied: string[] = [];
    for (const event of result.events) {
      const outcome = await deps.advance(run, event);
      applied.push(event.kind);
      for (const problem of outcome.problems) report.problems.push({ runId: run.id, problem });
    }
    report.reconciled.push({ runId: run.id, events: applied });
    return result.problems.length === 0;
  }

  /**
   * One run's pass: look at its gate, reconcile its PR, or nothing.
   *
   * `true` means the pass established something (or correctly found nothing
   * to do); `false` means it could not, and the run's cadence backs off. A
   * state that is neither a gate nor a reconcile is not due here at all --
   * `intervalFor` returned null -- so `true` is the honest answer for it.
   */
  async function passOne(run: RunRow, report: TickReport): Promise<boolean> {
    if (run.state === 'running') return lookAt(run, report);
    if (RECONCILES.has(run.state)) return reconcileRun(run, report);
    return true;
  }

  async function tick(): Promise<TickReport> {
    // at starts at 0 and is set inside the try, so even deps.now() throwing
    // is the tick's reported problem rather than a rejection: start() leans
    // on tick never rejecting, so the guarantee is total, not almost.
    const report: TickReport = { at: 0, due: [], looked: [], reconciled: [], skipped: [], problems: [], escalated: [] };
    try {
      report.at = deps.now();
      await runTick(report.at, report);
    } catch (err) {
      // The scheduling calls -- listActiveRuns, dueRuns -- sit here rather
      // than inside a per-run try, so a transient store error is the tick's
      // problem and the loop lives to try again, not an unhandled rejection
      // that kills unattended operation.
      report.problems.push({ runId: '(scheduler)', problem: err instanceof Error ? err.message : String(err) });
    }
    return report;
  }

  async function runTick(at: number, report: TickReport): Promise<void> {
    const active = deps.listActiveRuns();
    const seen = new Set<string>();
    for (const run of active) {
      remember(run);
      seen.add(run.id);
    }
    // A run that finished is not remembered forever.
    for (const id of [...memory.keys()]) if (!seen.has(id)) memory.delete(id);

    const byId = new Map(active.map((run) => [run.id, run]));
    for (const due of dueRuns([...memory.values()], at)) {
      const run = byId.get(due.id);
      if (!run) continue;
      report.due.push(run.id);
      let ok = false;
      try {
        ok = await passOne(run, report);
      } catch (err) {
        // One run's failure is not another's, and not the loop's. Reported,
        // counted against this run's cadence, and the tick goes on.
        report.problems.push({ runId: run.id, problem: err instanceof Error ? err.message : String(err) });
      }
      passed(run.id, ok, report);
    }
  }

  return {
    tick,
    start(everyMs) {
      if (timer) return;
      timer = setInterval(() => {
        if (ticking) return; // a slow tick is not two ticks
        ticking = true;
        void tick()
          .then((report) => {
            for (const p of report.problems) deps.log(`${p.runId} problem: ${p.problem}`);
            for (const id of report.escalated) deps.log(`${id} has failed ${memory.get(id)?.failures ?? '?'} passes in a row; a person should look`);
          })
          .catch((err: unknown) => {
            // tick() is written never to reject; this is the belt to that
            // suspenders, so a bug there is a log line and not a dead loop.
            deps.log(`the run loop tick threw: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => {
            ticking = false;
          });
      }, everyMs);
      // A pending tick must not hold the process open past shutdown.
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    schedule: () => memory,
  };
}
