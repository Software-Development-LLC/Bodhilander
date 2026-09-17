/**
 * Fetch a GitHub Projects v2 board, wired to the real app (board-driven
 * orchestration, Phase 1).
 *
 * The one side effect around the pure `board-reader`: shell `gh api graphql`
 * through the run engine's `processDeps().gh(...)` (inherits the ambient login +
 * the `project` scope), page through the project's items, then group them. A
 * `gh` failure, a GraphQL error, or hitting the page cap with more to fetch is a
 * fixable PROBLEM surfaced to the UI, never a silently empty or truncated board.
 *
 * `readProjectBoard` takes its `gh` and config as deps so the pagination + error
 * paths are testable dry; `fetchProjectBoard` supplies the real ones.
 */
import type { CommandResult } from '../run-engine/reconcile';
import { processDeps } from '../run-engine/command-runner';
import * as machine from '../run-engine/machine-config';
import { boardQueryArgv, parseBoardPage, buildBoard, type RawBoardNode } from './board-reader';
import type { BoardResult } from '../../shared/types';

/** Safety bound: 40 pages × 50 items = 2000 items, well past any real project. */
const MAX_PAGES = 40;

export interface BoardDeps {
  gh(argv: readonly string[]): Promise<CommandResult>;
  org: string | null;
  defaultProject: number | null;
  approvedStatus: string;
}

/**
 * Read a project's board through injected deps. Pages until the cursor runs out;
 * a partial read (cap hit with more to fetch) is reported as a problem rather
 * than a quietly short list.
 */
export async function readProjectBoard(deps: BoardDeps, projectNumber?: number): Promise<BoardResult> {
  if (!deps.org) {
    return { status: 'problem', problem: 'No GitHub org configured — set it in Settings → Run engine.' };
  }
  const number = projectNumber ?? deps.defaultProject;
  if (!number) {
    return { status: 'problem', problem: 'No project number configured — set a default in Settings → Run engine, or pick one.' };
  }

  const nodes: RawBoardNode[] = [];
  let title = '';
  let cursor: string | null = null;
  let pages = 0;
  do {
    const out = await deps.gh(boardQueryArgv(deps.org, number, cursor));
    if (out.code !== 0) {
      const stderr = out.stderr.trim();
      const why = stderr.length > 0 ? stderr : `exit ${out.code}`;
      return { status: 'problem', problem: `gh could not read project ${number}: ${why}` };
    }
    const page = parseBoardPage(out.stdout);
    if (page.status === 'problem') return { status: 'problem', problem: page.problem };
    nodes.push(...page.nodes);
    title = page.title;
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor && pages < MAX_PAGES);

  if (cursor) {
    // More pages remained at the cap: report it rather than under-count the
    // board's initiatives, matching the "problem, never a silent wrong answer"
    // discipline. A real project stays well under this.
    return { status: 'problem', problem: `project ${number} has more than ${MAX_PAGES * 50} items; refine the board or raise the page cap.` };
  }

  return { status: 'ok', project: buildBoard(nodes, { title, number }, deps.approvedStatus) };
}

/** Read the configured (or given) project's board with the real gh + settings. */
export function fetchProjectBoard(projectNumber?: number): Promise<BoardResult> {
  return readProjectBoard(
    {
      gh: (argv) => processDeps({ ghPath: machine.ghPath(), pythonPath: 'python' }).gh(argv),
      org: machine.githubOrg(),
      defaultProject: machine.projectNumber(),
      approvedStatus: machine.approvedStatus(),
    },
    projectNumber,
  );
}
