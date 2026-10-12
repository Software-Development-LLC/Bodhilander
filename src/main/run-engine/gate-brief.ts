/**
 * Telling a gate which run it is working (CO-722).
 *
 * The first real gate launch was handed `"Work gate 2 for BDH-239."` and
 * spent its opening move guessing where the initiative lived, in two
 * directories that did not exist. The harness tells a gate HOW to work; the
 * run is the only thing that knows WHAT it is working on, and none of it can
 * be derived from an agent file.
 *
 * ## Facts, never instructions
 *
 * This is the line the engine keeps having to redraw. Bodhilander sequences
 * and holds no domain knowledge, so the wording of what a gate should DO
 * belongs to the harness and to the caller. What belongs here is only what
 * the run knows and nobody else can: which initiative, which directory,
 * which repo, which worktree, which gate.
 *
 * So this composes a block of labelled values and then the caller's task text
 * verbatim. It must never grow a sentence telling a gate how to behave --
 * that is how a sequencer quietly becomes a second, worse copy of the
 * process, disagreeing with the harness and winning because it is closer.
 * The test pins the whole output for exactly that reason: anything added
 * fails it, rather than being absorbed.
 */
import type { Gate } from './transitions';

export interface RunFacts {
  /** The tracking key, e.g. `BDH-239`. What PR titles are searched for. */
  initiativeKey: string;
  /** Directory holding `team.yaml` and `seams.yaml` for this run. */
  initiativePath: string;
  /** The repo this gate is working, as the initiative names it. */
  repo: string;
  /** The worktree, which is also the gate's cwd -- stated because a gate
   *  that only infers it from cwd cannot tell a worktree from a checkout. */
  worktree: string;
  /** The pinned harness. Its scripts are absolute from here, not relative. */
  harnessPath: string;
  gate: Gate;
  /**
   * Externally-authored context for this repo/owner from the central config
   * (Phase 4) — the team's domain knowledge, not the app's. Passed through
   * verbatim like `task`: the app invents nothing, it only carries what the
   * config author wrote. Absent when the config names none.
   */
  context?: string | null;
}

/**
 * The run's facts, then the task, unchanged.
 *
 * `task` is passed through exactly as given. Trimmed only at the ends, so a
 * caller cannot accidentally change its meaning by indenting it.
 */
export function gateBrief(facts: RunFacts, task: string): string {
  const lines = [
    '# This run',
    '',
    `initiative   ${facts.initiativeKey}`,
    `repo         ${facts.repo}`,
    `gate         ${facts.gate}`,
    `worktree     ${facts.worktree}`,
    `directory    ${facts.initiativePath}`,
    `harness      ${facts.harnessPath}`,
    '',
    // Said explicitly because both were guessed wrong on the first real
    // launch: the initiative is not in the repo, and the harness scripts are
    // not reachable by a relative path from a worktree.
    'team.yaml and seams.yaml are in the initiative directory above.',
    'Harness scripts are under the harness path above, by absolute path.',
    '',
    // The config's context for this repo/owner, verbatim — data the author
    // wrote, carried like the task, only when present.
    ...(facts.context && facts.context.trim().length > 0 ? ['# Context', '', facts.context.trim(), ''] : []),
    '# Task',
    '',
    task.trim(),
  ];
  return lines.join('\n');
}
