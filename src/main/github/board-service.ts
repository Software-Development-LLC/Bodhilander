/**
 * Fetch a GitHub Projects v2 board, wired to the real app (board-driven
 * orchestration, Phase 1).
 *
 * The one side effect around the pure `board-reader`: shell `gh api graphql`
 * through the run engine's `processDeps().gh(...)` (inherits the ambient login +
 * the `project` scope), page through the project's items, then group them. A
 * `gh` failure or a GraphQL error is a fixable PROBLEM surfaced to the UI, never
 * a silently empty board.
 */
import { processDeps } from '../run-engine/command-runner';
import * as machine from '../run-engine/machine-config';
import { boardQueryArgv, parseBoardPage, buildBoard, type RawBoardNode } from './board-reader';
import type { BoardResult } from '../../shared/types';

/** Safety bound: 20 pages × 50 items = 1000 items, well past any real project. */
const MAX_PAGES = 20;

/**
 * Read the configured (or given) project's board. Reads org / default project /
 * eligibility Status from machine-config, so the renderer passes only an
 * optional project number override.
 */
export async function fetchProjectBoard(projectNumber?: number): Promise<BoardResult> {
  const org = machine.githubOrg();
  if (!org) {
    return { status: 'problem', problem: 'No GitHub org configured — set it in Settings → Run engine.' };
  }
  const number = projectNumber ?? machine.projectNumber();
  if (!number) {
    return { status: 'problem', problem: 'No project number configured — set a default in Settings → Run engine, or pick one.' };
  }
  const approvedStatus = machine.approvedStatus();
  const gh = processDeps({ ghPath: machine.ghPath(), pythonPath: 'python' }).gh;

  const nodes: RawBoardNode[] = [];
  let cursor: string | null = null;
  let meta = { title: '', number };
  let pages = 0;
  do {
    const out = await gh(boardQueryArgv(org, number, cursor));
    if (out.code !== 0) {
      return { status: 'problem', problem: `gh could not read project ${number}: ${out.stderr.trim() || `exit ${out.code}`}` };
    }
    const page = parseBoardPage(out.stdout);
    if (page.status === 'problem') return { status: 'problem', problem: page.problem };
    nodes.push(...page.nodes);
    meta = { title: page.title, number: page.number };
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor && pages < MAX_PAGES);

  return { status: 'ok', project: buildBoard(nodes, meta, approvedStatus) };
}
