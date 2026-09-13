/**
 * Starting a run, and refusing to (CO-722).
 *
 * Every other module here assumes a run exists. This is the one that makes
 * one, and almost all of it is about NOT making one.
 *
 * The design's rule is blunt and it is the right one: **half a working
 * orchestrator is worse than none.** A run that starts without a Python it
 * can drive, or without a harness to read roles from, does not fail at the
 * start where somebody would understand it — it fails four gates in, having
 * cut worktrees and spent tokens, with a message about whatever happened to
 * break first. So everything is checked before anything is written, each
 * refusal names what is missing, and each one says what to do about it.
 *
 * The Python check runs the interpreter rather than looking for its name,
 * which is the plugin's own rule and not a general nicety: on Windows
 * `python3` resolves to a WindowsApps alias that exits non-zero with a Store
 * advertisement. It is on PATH, it is not Python, and a check that asked
 * `command -v` passed on it.
 *
 * Nothing here starts anything. A created run is ARMED: its rows exist, its
 * owners are recorded, and it sits in `preparing` until somebody says go.
 * Starting cuts worktrees and launches an agent that writes, which is the
 * first genuinely irreversible thing this system does, and the design says
 * phase 3 ships dark until one real run has passed.
 */
import { randomUUID } from 'crypto';
import { agentsForRepo } from './gate-launcher';
import type { CommandResult } from './reconcile';
import * as runs from '../repositories/runs';
import type { PermissionPosture } from '../repositories/runs';

export interface IgnitionDeps {
  /** Run anything. The same shape the reconciler uses. */
  run(executable: string, argv: readonly string[]): Promise<CommandResult>;
}

export interface IgnitionRequest {
  initiativePath: string;
  harnessPath: string;
  bodhiRoot: string;
  pythonPath: string;
  ghPath: string;
  posture: PermissionPosture;
  budgetUsd?: number | null;
  /**
   * Owner roles a person picked, per repo.
   *
   * Needed only where the harness offers more than one — a lead who owns what
   * cuts across a repo, and domain owners who own their own modules. Choosing
   * between them is judgment, so the engine asks rather than guesses.
   */
  owners?: Record<string, string>;
}

/** Something missing, and what to do about it. */
export interface Refusal {
  what: string;
  fix: string;
}

export type IgnitionResult =
  | {
      status: 'armed';
      runId: string;
      initiativeKey: string;
      /** Repo to the role that will run gate 2 there. */
      owners: Record<string, string>;
    }
  | { status: 'refused'; refusals: Refusal[] };

interface InitiativePayload {
  initiative?: string | null;
  owners?: Record<string, { worktree?: string; branch?: string; base?: string; scratch?: string }>;
  detail?: string;
}

function parse<T>(text: string): T | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

/**
 * Can this interpreter actually run?
 *
 * By running it. `command -v python3` passes on a WindowsApps alias that is
 * not Python — measured, and the reason the plugin's own `bodhi_python`
 * probes by execution. A name on PATH is not evidence.
 */
async function pythonWorks(request: IgnitionRequest, deps: IgnitionDeps): Promise<boolean> {
  const probe = await deps.run(request.pythonPath, ['-c', 'import sys; sys.exit(0)']);
  return probe.code === 0;
}

async function ghWorks(request: IgnitionRequest, deps: IgnitionDeps): Promise<boolean> {
  return (await deps.run(request.ghPath, ['--version'])).code === 0;
}

/**
 * Which role owns gate 2 for each repo, or a refusal saying why not.
 *
 * A repo the harness gives exactly one candidate for is decided. Several
 * candidates is a choice, and the engine refuses it: picking between a lead
 * and a domain owner is judgment about the change, and a wrong pick is an
 * agent editing a module that is not theirs. None at all is a repo nobody
 * owns, which is not a run that can start.
 */
async function resolveOwners(
  repos: readonly string[],
  request: IgnitionRequest,
): Promise<{ owners: Record<string, string>; refusals: Refusal[] }> {
  const owners: Record<string, string> = {};
  const refusals: Refusal[] = [];
  for (const repo of repos) {
    const chosen = request.owners?.[repo];
    const candidates = await agentsForRepo(request.harnessPath, repo);
    if (chosen) {
      if (!candidates.includes(chosen)) {
        refusals.push({
          what: `${chosen} does not own ${repo} in this harness`,
          fix: candidates.length
            ? `Choose one of: ${candidates.join(', ')}`
            : `No agent in this harness declares repo: ${repo}`,
        });
        continue;
      }
      owners[repo] = chosen;
      continue;
    }
    if (candidates.length === 1) {
      owners[repo] = candidates[0];
      continue;
    }
    refusals.push({
      what: candidates.length === 0
        ? `no agent in this harness declares repo: ${repo}`
        : `${repo} has ${candidates.length} possible owners`,
      fix: candidates.length === 0
        ? `Add an owner to the harness, or check the repo name against team.yaml`
        : `Name one for this run: ${candidates.join(', ')}`,
    });
  }
  return { owners, refusals };
}

/**
 * Check everything, then write the run — or write nothing and say why.
 *
 * Every check runs even after one fails, because a person fixing a machine
 * wants the whole list. Reporting the first missing thing, then the next on
 * the retry, is three round trips for one problem.
 */
export async function armRun(
  request: IgnitionRequest,
  deps: IgnitionDeps,
): Promise<IgnitionResult> {
  const refusals: Refusal[] = [];

  if (!(await pythonWorks(request, deps))) {
    refusals.push({
      what: `python at ${request.pythonPath} did not run`,
      fix: 'Point BODHI_PYTHON at a real interpreter. On Windows a bare `python3` can '
        + 'be a Store alias that is on PATH and is not Python.',
    });
  }
  if (!(await ghWorks(request, deps))) {
    refusals.push({
      what: `gh at ${request.ghPath} did not run`,
      fix: 'Install the GitHub CLI and sign in. Every check and review this run reads '
        + 'comes through it.',
    });
  }

  const read = await deps.run(request.pythonPath, [
    `${request.harnessPath}/scripts/lib/initiative.py`,
    request.initiativePath,
  ]);
  const payload = parse<InitiativePayload>(read.stdout);
  if (read.code !== 0 || !payload) {
    refusals.push({
      what: `the initiative at ${request.initiativePath} could not be read`,
      // The plugin's own sentence: it knows whether this is a directory
      // nobody started or one whose owners spawn.sh has not filled in yet,
      // and those have different answers.
      fix: payload?.detail ?? read.stderr.trim() ?? 'Check the path.',
    });
    return { status: 'refused', refusals };
  }

  const repos = Object.keys(payload.owners ?? {});
  const resolved = await resolveOwners(repos, request);
  refusals.push(...resolved.refusals);

  if (refusals.length > 0) return { status: 'refused', refusals };

  const runId = randomUUID();
  const initiativeKey = payload.initiative ?? '';
  runs.createRun({
    id: runId,
    initiativeKey,
    initiativeDir: request.initiativePath,
    harnessPath: request.harnessPath,
    bodhiRoot: request.bodhiRoot,
    pythonPath: request.pythonPath,
    permissionPosture: request.posture,
    budgetUsd: request.budgetUsd ?? null,
  });
  for (const [repo, owner] of Object.entries(payload.owners ?? {})) {
    runs.upsertOwner({
      runId,
      repo,
      worktree: owner.worktree ?? '',
      branch: owner.branch ?? '',
      base: owner.base ?? '',
      scratch: owner.scratch ?? null,
      status: 'pending',
      prNumber: null,
      prUrl: null,
    });
  }

  // Armed, not started. The rows exist and nothing has been cut, launched or
  // pushed. `preparing` is where createRun leaves it, and it stays there
  // until somebody advances it.
  return { status: 'armed', runId, initiativeKey, owners: resolved.owners };
}
