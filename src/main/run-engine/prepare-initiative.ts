/**
 * Preparing an initiative from the app (CO-722).
 *
 * Arming operates an initiative the harness already set up. This is the step
 * before it: it runs the harness's own two bootstrap scripts so a person never
 * has to drop to a terminal to start a run.
 *
 *   init_task.py <issue> <repo> --dir <initiatives-root>
 *       writes the initiative's seams.yaml and team.yaml (gates 0 and 1).
 *   spawn.py <initiative-dir>   (with BODHI_ROOT set)
 *       cuts the owners' worktrees and fills team.yaml's owners block.
 *
 * Both are invoked exactly as `ignition.ts` invokes `initiative.py`: the python
 * interpreter against the harness's library file, never the `.sh` wrappers
 * (Windows cannot spawn those without a shell). After this succeeds the
 * directory is a prepared initiative, and the ordinary arm path takes it.
 *
 * Like `arm-run`, this REFUSES with a fixable list rather than throwing: a
 * missing machine setting, an unusable issue name, or a script that failed all
 * read the same way in the UI -- "here is what to fix" -- and nothing is left
 * half-created that the person did not ask about.
 */
import * as path from 'path';
import type { RunPrepareResult } from '../../shared/types';

/** What preparing needs to know about the machine; each is refused if absent. */
export interface PrepareConfig {
  pythonPath: string;
  harnessPath: string | null;
  bodhiRoot: string | null;
  initiativesRoot: string | null;
}

export interface PrepareRequest {
  issueId: string;
  repo: string;
  /** The initiative's dollar budget; the harness has its own default when omitted. */
  budgetUsd?: number;
}

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** The one side effect: running a harness script. Injected so the path is testable dry. */
export interface PrepareIo {
  run(
    executable: string,
    argv: readonly string[],
    opts: { env?: Record<string, string> },
  ): Promise<CommandOutput>;
}

/** The issue id must be usable as a directory name -- the harness enforces the same shape. */
const ISSUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function refuse(refusals: { what: string; fix: string }[], log?: string): RunPrepareResult {
  return { status: 'refused', refusals, log };
}

/**
 * The repo names a harness offers, read from its `registry.yaml`.
 *
 * The keys under the top-level `repos:` map, in file order. Parsed with a line
 * scanner rather than a YAML dependency: the file is large (hundreds of repos)
 * and this needs only the keys, so a scanner that stops caring at the first
 * dedent is both lighter and unable to be surprised by value syntax it does not
 * read. A key is a two-space-indented `name:` with nothing after the colon;
 * the nested `path:` lines are more deeply indented and never match.
 */
export function reposFromRegistry(text: string): string[] {
  const repos: string[] = [];
  let inRepos = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^repos:\s*$/.test(line)) {
      inRepos = true;
      continue;
    }
    if (!inRepos) continue;
    if (/^\S/.test(line)) break; // dedented back to a top-level key; the map is over
    const match = /^ {2}([A-Za-z0-9][\w.-]*):\s*$/.exec(line);
    if (match) repos.push(match[1]);
  }
  return repos;
}

/**
 * Run the harness's bootstrap for one single-repo task, or refuse with a list.
 *
 * The order matters: every missing machine setting is collected first so a
 * person fixes Settings once, and only then are the scripts run -- init_task
 * before spawn, because spawn reads the team.yaml init_task writes. A failed
 * script stops the sequence and returns its output as the fix, because the
 * harness's own message is more precise than anything this wrapper could say.
 */
export async function prepareInitiative(
  request: PrepareRequest,
  io: PrepareIo,
  config: PrepareConfig,
): Promise<RunPrepareResult> {
  const refusals: { what: string; fix: string }[] = [];
  if (!config.harnessPath) {
    refusals.push({ what: 'no harness is configured', fix: 'Set the harness path in Settings → Run engine.' });
  }
  if (!config.bodhiRoot) {
    refusals.push({ what: 'no workspace root is configured', fix: 'Set BODHI_ROOT (the folder holding the repo clones) in Settings → Run engine.' });
  }
  if (!config.initiativesRoot) {
    refusals.push({ what: 'no initiatives folder is configured', fix: 'Set where initiatives are written in Settings → Run engine.' });
  }
  if (!ISSUE_ID.test(request.issueId)) {
    refusals.push({ what: `${request.issueId || '(empty)'} is not usable as an initiative name`, fix: 'Use letters, digits, dot, dash or underscore, starting with a letter or digit.' });
  }
  if (!request.repo.trim()) {
    refusals.push({ what: 'no repo was chosen', fix: 'Pick the repo this task changes.' });
  }
  if (refusals.length > 0) return refuse(refusals);

  // Narrowed by the guards above; asserted so the types read straight.
  const harnessPath = config.harnessPath as string;
  const bodhiRoot = config.bodhiRoot as string;
  const initiativesRoot = config.initiativesRoot as string;

  const initArgv = [
    `${harnessPath}/scripts/lib/init_task.py`,
    request.issueId,
    request.repo,
    '--dir',
    initiativesRoot,
  ];
  if (request.budgetUsd !== undefined) initArgv.push('--budget', String(request.budgetUsd));
  const init = await io.run(config.pythonPath, initArgv, {});
  if (init.code !== 0) {
    return refuse(
      [{ what: `init-task did not create ${request.issueId}`, fix: firstLine(init.stderr, init.stdout) ?? 'Check the issue id and repo.' }],
      join(init.stdout, init.stderr),
    );
  }

  const initiativeDir = path.join(initiativesRoot, request.issueId);
  const spawn = await io.run(config.pythonPath, [`${harnessPath}/scripts/lib/spawn.py`, initiativeDir], {
    env: { BODHI_ROOT: bodhiRoot },
  });
  if (spawn.code !== 0) {
    return refuse(
      [{ what: `worktrees for ${request.issueId} could not be cut`, fix: firstLine(spawn.stderr, spawn.stdout) ?? 'Check that the repo is cloned under BODHI_ROOT.' }],
      join(init.stdout, init.stderr, spawn.stdout, spawn.stderr),
    );
  }

  return { status: 'prepared', initiativeDir, log: join(init.stdout, spawn.stdout) };
}

/** The first non-empty line across the given texts, for a one-line fix. */
function firstLine(...texts: string[]): string | null {
  for (const text of texts) {
    const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (line) return line;
  }
  return null;
}

/** Join the non-empty pieces with blank lines, for the shown log. */
function join(...pieces: string[]): string {
  return pieces.map((p) => p.trim()).filter(Boolean).join('\n\n');
}
