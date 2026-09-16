/**
 * Arming a run from a prepared initiative directory (CO-722).
 *
 * The console armed a run by pointing `armRun` at an initiative that
 * `init-task.sh` and `spawn.sh` had already prepared -- team.yaml written,
 * worktrees cut. This does the same from the app: a person picks that
 * directory, and this reads what the harness wrote and hands it to `armRun`,
 * which checks the machine and writes the run's rows or refuses with a list.
 *
 * Bootstrapping an initiative (cutting worktrees) stays a harness concern --
 * it is `spawn.sh`, run where the repos live. The app's job is to arm one
 * that already exists, which is the seam a person actually crosses when a run
 * is ready to start.
 *
 * The harness path is READ from the initiative's own team.yaml rather than
 * configured in the app: it is the one the run is pinned to, written when the
 * initiative was bootstrapped, and a second copy in app settings could
 * disagree with it. The repo root follows from it by convention -- the
 * harness clone sits beside the others under it.
 */
import * as path from 'path';
import type { IgnitionRequest, IgnitionResult } from './ignition';

/**
 * The harness path a team.yaml pins the run to, or null.
 *
 * A flat `harness:` line, because that is how `init-task.sh` writes it and
 * agent front matter is never nested. Quotes are stripped: the value may be a
 * Windows path a person quoted, and the raw value is what `--plugin-dir`
 * takes.
 */
export function harnessFromTeamYaml(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    // A single greedy capture with no lazy quantifier and no trailing `\s*`, so
    // there is nothing to backtrack over on a long line (S5852). Whitespace is
    // handled by trim() below, not by the pattern.
    const match = /^harness:(.*)$/.exec(line);
    if (match) {
      // Strip a MATCHED pair of quotes only, so a path that merely contains a
      // quote is left intact rather than losing its first and last characters.
      const value = match[1].trim().replace(/^(["'])(.*)\1$/, '$2').trim();
      return value || null;
    }
  }
  return null;
}

/**
 * The repos in a seams.yaml's `merge_order`, in order (CO-722).
 *
 * Handles both the block form init-task writes (`merge_order:` then `- repo`
 * lines) and the flow form (`merge_order: [a, b, c]`). Returns [] when there
 * is no such key -- display only, so an absent order is not an error.
 *
 * The item pattern takes a bare token, which is what a repo slug is; it does
 * not strip surrounding quotes or allow spaces in a name. That is the shape
 * the harness writes, and since this only orders a display, a manifest that
 * quoted a repo would show that repo unordered rather than mis-order anything.
 */
export function mergeOrderFromSeams(text: string): string[] {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const flow = /^merge_order:\s*\[(.*)\]\s*$/.exec(lines[i]);
    if (flow) {
      return flow[1].split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (/^merge_order:\s*$/.test(lines[i])) {
      const repos: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const item = /^\s*-\s*(\S+)\s*$/.exec(lines[j]);
        if (item) repos.push(item[1]);
        else if (lines[j].trim() !== '' && !lines[j].trim().startsWith('#')) break;
      }
      return repos;
    }
  }
  return [];
}

export interface ArmIo {
  /** A file's text, or null when it does not exist. */
  readFile(path: string): string | null;
}

export interface ArmConfig {
  pythonPath: string;
  ghPath: string;
}

function refused(what: string, fix: string): IgnitionResult {
  return { status: 'refused', refusals: [{ what, fix }] };
}

/**
 * Arm the run in a prepared initiative directory.
 *
 * Refuses -- rather than throwing -- when the directory is not a prepared
 * initiative, so the UI shows the same "here is what to fix" list `armRun`
 * itself produces rather than a crash. `arm` is a dependency so the whole
 * thing is testable without a real python or gh.
 */
export async function armInitiative(
  initiativeDir: string,
  io: ArmIo,
  arm: (request: IgnitionRequest) => Promise<IgnitionResult>,
  config: ArmConfig,
): Promise<IgnitionResult> {
  const teamPath = path.join(initiativeDir, 'team.yaml');
  const text = io.readFile(teamPath);
  if (text === null) {
    return refused(
      `no team.yaml in ${initiativeDir}`,
      'Pick an initiative directory that init-task.sh and spawn.sh have prepared.',
    );
  }
  const harnessPath = harnessFromTeamYaml(text);
  if (!harnessPath) {
    return refused(
      `${teamPath} declares no harness`,
      'The initiative must pin a harness. Re-run init-task.sh, which writes it.',
    );
  }
  // seams.yaml declares the merge order; read it for display (the engine does
  // not gate on it). Absent or unreadable is fine -- a single-repo run has a
  // trivial order and this is only a convenience.
  const seams = io.readFile(path.join(initiativeDir, 'seams.yaml'));
  const mergeOrder = seams ? mergeOrderFromSeams(seams) : [];
  return arm({
    initiativePath: initiativeDir,
    harnessPath,
    mergeOrder,
    // The harness clone sits beside the other repos, so its parent is the
    // root the plugin's scripts read other repos out of (BODHI_ROOT).
    bodhiRoot: path.dirname(harnessPath),
    pythonPath: config.pythonPath,
    ghPath: config.ghPath,
    posture: 'manual',
    // No pre-chosen owners: where the harness offers several, armRun refuses
    // and names them, and a later arm can carry the choice. One owner per
    // repo -- the common case -- resolves without asking.
    owners: {},
  });
}
