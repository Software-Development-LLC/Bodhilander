/**
 * Continuous auto-drive: start runs from the board on a timer (CO-722 Workstream B).
 *
 * The run loop drives runs that already exist; nothing created them without a
 * person clicking Initiate. This closes that last manual step: aim the engine at
 * a project and it keeps pulling eligible initiatives, one wave at a time, and
 * starts a run for each -- until halted, and never more than the operator's caps
 * allow. Everything past "start the run" is the loop's job, and B2's manifest
 * auto-approve makes each started run hands-off to PR-ready.
 *
 * It is off unless turned on. A run started on its own spends real quota, so the
 * safe default is to do nothing, and the caps (a per-day budget and a
 * max-concurrent limit) exist precisely to preserve usage -- the reason auto-drive
 * was asked for a cap in the first place.
 *
 * Like the run loop, this knows nothing of Electron, the database or `gh`: every
 * dependency is injected, so the decision -- which initiatives, how many, in what
 * order -- is a pure function a test can drive without a clock or a network.
 */
import type { BoardInitiative, BoardResult, RunCrossRepoPrepareResult } from '../../shared/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** An initiative the watcher would start, already keyed and scoped. */
export interface WatchCandidate {
  key: string;
  repos: string[];
  priority: string | null;
  number: number;
}

/** What one watcher tick did, for logging and tests. */
export interface WatchReport {
  /** Why the tick did nothing, when it did nothing (disabled, no project, board unreadable). */
  skipped: string | null;
  /** Initiatives started this tick, in the order they were started. */
  started: { key: string; runId: string }[];
  /** Eligible-but-not-started keys and why (already run, or a refusal). */
  held: { key: string; why: string }[];
}

export interface BoardWatcherDeps {
  now(): number;
  /** The halt switch: false means the watcher does nothing this tick. */
  enabled(): boolean;
  /** The project to watch, or null when none is configured (then the tick is a no-op). */
  projectNumber(): number | null;
  /** The most runs auto-drive may create per trailing 24h; null/0 = unlimited. */
  perDayCap(): number | null;
  /** The most runs (any origin) that may be active before the watcher stops starting more. */
  maxConcurrent(): number;
  /** Read the board (annotated with in-progress state). */
  readBoard(projectNumber: number): Promise<BoardResult>;
  /** How many runs are active right now (all origins). */
  countActiveRuns(): number;
  /** How many runs were created since the given epoch-ms. */
  countRunsCreatedSince(sinceEpochMs: number): number;
  /** Whether any run has ever existed for this key (one-run-ever dedup). */
  hasRunForKey(key: string): boolean;
  /** Start a cross-repo run for a key + repos (the same path Initiate uses). */
  startRun(key: string, repos: string[]): RunCrossRepoPrepareResult;
  log(line: string): void;
}

/** The `KEY-N` tracking key inside a board initiative's title (e.g. `[CO-838] …`), or null. */
export function initiativeKeyOf(title: string): string | null {
  const m = /\[([A-Za-z][A-Za-z0-9]*-\d+)\]/.exec(title);
  return m ? m[1] : null;
}

/**
 * A best-effort rank for a priority value, lowest number = most urgent, so
 * candidates can be ordered under a cap. Handles the common `P0..Pn` scale and
 * the high/medium/low words; an unknown or missing priority sorts last, never
 * ahead of a named one. This orders which eligible initiatives get the scarce
 * slots -- it never decides eligibility.
 */
export function priorityRank(priority: string | null): number {
  if (!priority) return Number.POSITIVE_INFINITY;
  const p = priority.trim().toLowerCase();
  const scale = /^p(\d+)$/.exec(p);
  if (scale) return Number.parseInt(scale[1], 10);
  const words: Record<string, number> = {
    urgent: 0, critical: 0, highest: 0, high: 1, medium: 2, normal: 2, low: 3, lowest: 4,
  };
  return words[p] ?? Number.POSITIVE_INFINITY;
}

/**
 * The eligible initiatives the watcher may start, keyed and ordered (CO-722).
 *
 * An initiative qualifies when the board marked it eligible, it is not already
 * in progress, its title carries a `[KEY-N]`, and no run has ever existed for
 * that key (the one-run-ever dedup -- a completed or abandoned key is a manual
 * re-Initiate, never automatic). Ordered by priority then issue number, so under
 * a cap the most urgent, oldest work goes first.
 */
export function selectCandidates(
  initiatives: readonly BoardInitiative[],
  hasRunForKey: (key: string) => boolean,
): WatchCandidate[] {
  const candidates: WatchCandidate[] = [];
  for (const init of initiatives) {
    if (!init.eligible || init.inProgress) continue;
    const key = initiativeKeyOf(init.item.title);
    if (key === null || hasRunForKey(key)) continue;
    candidates.push({ key, repos: init.repos, priority: init.item.priority, number: init.item.number });
  }
  return candidates.sort((a, b) => {
    const ra = priorityRank(a.priority);
    const rb = priorityRank(b.priority);
    if (ra !== rb) return ra - rb;
    return a.number - b.number;
  });
}

/**
 * How many runs the watcher may start this tick: the smaller of the remaining
 * concurrency budget and the remaining per-day budget, never below zero. A null
 * or non-positive per-day cap means the day never limits it.
 */
export function startBudget(
  active: number,
  maxConcurrent: number,
  createdToday: number,
  perDayCap: number | null,
): number {
  const concurrency = Math.max(0, maxConcurrent - active);
  const day = perDayCap === null || perDayCap <= 0 ? Number.POSITIVE_INFINITY : Math.max(0, perDayCap - createdToday);
  return Math.min(concurrency, day);
}

/**
 * One watcher pass: read the board, pick the eligible-and-undriven initiatives,
 * and start up to the budget's worth. Never rejects; a bad board read is a skip,
 * not a throw, so the timer keeps ticking. A refusal from `startRun` holds that
 * one initiative (and does not spend budget) rather than failing the pass.
 */
export async function watchTick(deps: BoardWatcherDeps): Promise<WatchReport> {
  const empty: WatchReport = { skipped: null, started: [], held: [] };
  if (!deps.enabled()) return { ...empty, skipped: 'auto-drive is off' };
  const projectNumber = deps.projectNumber();
  if (projectNumber === null) return { ...empty, skipped: 'no project configured' };

  let board: BoardResult;
  try {
    board = await deps.readBoard(projectNumber);
  } catch (err) {
    return { ...empty, skipped: `board read threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (board.status !== 'ok') return { ...empty, skipped: `board unreadable: ${board.problem}` };

  const candidates = selectCandidates(board.project.initiatives, deps.hasRunForKey);
  if (candidates.length === 0) return empty;

  const now = deps.now();
  let budget = startBudget(
    deps.countActiveRuns(),
    deps.maxConcurrent(),
    deps.countRunsCreatedSince(now - DAY_MS),
    deps.perDayCap(),
  );

  const started: WatchReport['started'] = [];
  const held: WatchReport['held'] = [];
  for (const cand of candidates) {
    if (budget <= 0) {
      held.push({ key: cand.key, why: 'cap reached this tick' });
      continue;
    }
    const result = deps.startRun(cand.key, cand.repos);
    if (result.status === 'prepared') {
      started.push({ key: cand.key, runId: result.runId });
      budget -= 1;
      deps.log(`[BoardWatcher] started ${cand.key} (${result.runId}) for ${cand.repos.join(', ')}`);
    } else {
      const why = result.refusals.map((r) => r.what).join('; ');
      held.push({ key: cand.key, why });
      deps.log(`[BoardWatcher] held ${cand.key}: ${why}`);
    }
  }
  return { skipped: null, started, held };
}

export interface BoardWatcher {
  /** One pass. Never rejects. */
  tick(): Promise<WatchReport>;
  start(everyMs: number): void;
  stop(): void;
}

/**
 * A watcher on a timer, overlap-safe: a tick that is still running (a slow board
 * read) is not started again by the next fire, mirroring the run loop's guard.
 * The timer is unref'd so it never holds the process open on its own.
 */
export function createBoardWatcher(deps: BoardWatcherDeps): BoardWatcher {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function tick(): Promise<WatchReport> {
    try {
      return await watchTick(deps);
    } catch (err) {
      // A watcher must never take the process down; report and keep the timer.
      deps.log(`[BoardWatcher] tick failed: ${err instanceof Error ? err.message : String(err)}`);
      return { skipped: 'tick failed', started: [], held: [] };
    }
  }

  return {
    tick,
    start(everyMs: number): void {
      if (timer) return;
      timer = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        void tick().finally(() => { inFlight = false; });
      }, everyMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
