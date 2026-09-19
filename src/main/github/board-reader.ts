/**
 * Read a GitHub Projects v2 board (board-driven orchestration, Phase 1).
 *
 * Read-only. Built as `gh api graphql` argv run through the run engine's existing
 * `processDeps().gh(...)` runner, so it inherits the ambient `gh` login (the
 * `project` scope) exactly like PR discovery / reconcile — no octokit, no token
 * plumbing. Pure argv-builder + pure parser + pure grouping, so the whole thing
 * is testable dry and the caller owns the one side effect (the `gh` spawn).
 *
 * Eligibility gates on the initiative's **"Approved for Development"** value —
 * the team's human-approval column, already maintained on the board, so nothing
 * is migrated. That column is a GitHub **Issue Field** (org-level structured
 * issue metadata), NOT a Projects v2 field: its value is read via
 * `issueFieldValues` on the Issue, because the Projects v2 field query returns
 * `options: []` for it. "Priority" is read the same way, for candidate ordering.
 * The in-app run approval remains the final human checkpoint before anything
 * drives. See docs/design-board-driven-orchestration.md.
 */
import type { BoardInitiative, BoardItem, BoardProject } from '../../shared/types';

/**
 * One page of a project's items. `parent { number repository }` is fetched so a
 * child can be linked to its initiative unambiguously — child issue numbers are
 * per-repo, so a bare number would collide across repos.
 */
const BOARD_QUERY = `
query($org:String!, $number:Int!, $cursor:String) {
  organization(login:$org) {
    projectV2(number:$number) {
      title
      number
      items(first:50, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          content {
            __typename
            ... on Issue {
              number title state url
              repository { name }
              parent { number repository { name } }
              assignees(first:10) { nodes { login } }
              issueFieldValues(first:20) {
                nodes {
                  __typename
                  ... on IssueFieldSingleSelectValue {
                    name
                    field { ... on IssueFieldSingleSelect { name } }
                  }
                }
              }
            }
          }
          status: fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
      }
    }
  }
}`;

/** The `gh api graphql` argv for one page of a project's board. */
export function boardQueryArgv(org: string, projectNumber: number, cursor?: string | null): string[] {
  const argv = ['api', 'graphql', '-f', `org=${org}`, '-F', `number=${projectNumber}`];
  if (cursor) argv.push('-f', `cursor=${cursor}`);
  argv.push('-f', `query=${BOARD_QUERY}`);
  return argv;
}

/** A raw item node as it needs to survive across pages before grouping. */
export interface RawBoardNode {
  number: number;
  title: string;
  repo: string;
  state: string;
  status: string | null;
  url: string;
  assignees: string[];
  parent: { repo: string; number: number } | null;
  /** Issue Field single-select values, keyed by field name (e.g. "Approved for Development", "Priority"). */
  issueFields: Record<string, string>;
}

export type BoardPage =
  | { status: 'page'; title: string; number: number; nodes: RawBoardNode[]; nextCursor: string | null }
  | { status: 'problem'; problem: string };

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Collect an issue's single-select Issue Field values into a name→value map
 * (e.g. `{ "Approved for Development": "Approved", "Priority": "High" }`). Issue
 * Fields are org-level metadata read off the Issue, not Projects v2 fields.
 */
function parseIssueFields(content: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = (content.issueFieldValues as { nodes?: unknown } | undefined)?.nodes;
  if (!Array.isArray(raw)) return out;
  for (const fv of raw as Record<string, unknown>[]) {
    if (!fv || fv.__typename !== 'IssueFieldSingleSelectValue') continue;
    const fieldName = str((fv.field as { name?: unknown } | undefined)?.name);
    const value = str(fv.name);
    if (fieldName && value) out[fieldName] = value;
  }
  return out;
}

/**
 * Parse one page of `gh api graphql` output into typed raw nodes.
 *
 * Mirrors the reconcile/pr-discovery discipline: never throws, and a `gh` that
 * exits 0 but returns a GraphQL `errors[]` (or an inaccessible project) is a
 * PROBLEM the caller retries, never a silent empty board.
 */
export function parseBoardPage(stdout: string): BoardPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { status: 'problem', problem: 'board query returned output that is not JSON' };
  }
  const root = parsed as { data?: unknown; errors?: unknown };
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    const first = root.errors[0] as { message?: unknown };
    return { status: 'problem', problem: `board query errored: ${str(first?.message) || 'unknown GraphQL error'}` };
  }
  const proj = (root.data as { organization?: { projectV2?: unknown } } | undefined)?.organization?.projectV2 as
    | { title?: unknown; number?: unknown; items?: { nodes?: unknown; pageInfo?: unknown } }
    | null
    | undefined;
  if (!proj) {
    return { status: 'problem', problem: 'project not found or not accessible (check org, number, and the token\'s project scope)' };
  }
  const items = proj.items;
  const rawNodes = items && Array.isArray(items.nodes) ? items.nodes : [];
  const nodes: RawBoardNode[] = [];
  for (const raw of rawNodes as Record<string, unknown>[]) {
    const content = raw.content as Record<string, unknown> | null;
    // Only real issues drive work; skip pull requests and draft cards.
    if (!content || content.__typename !== 'Issue') continue;
    const repo = str((content.repository as { name?: unknown } | undefined)?.name);
    const number = typeof content.number === 'number' ? content.number : null;
    if (!repo || number === null) continue;
    const parentRaw = content.parent as { number?: unknown; repository?: { name?: unknown } } | null;
    const parent =
      parentRaw && typeof parentRaw.number === 'number' && str(parentRaw.repository?.name)
        ? { repo: str(parentRaw.repository!.name), number: parentRaw.number }
        : null;
    const assignees = (((content.assignees as { nodes?: unknown } | undefined)?.nodes as { login?: unknown }[]) ?? [])
      .map((a) => str(a?.login))
      .filter(Boolean);
    nodes.push({
      number,
      title: str(content.title),
      repo,
      state: str(content.state),
      status: str((raw.status as { name?: unknown } | undefined)?.name) || null,
      url: str(content.url),
      assignees,
      parent,
      issueFields: parseIssueFields(content),
    });
  }
  const pageInfo = items?.pageInfo as { hasNextPage?: unknown; endCursor?: unknown } | undefined;
  const nextCursor = pageInfo?.hasNextPage === true ? str(pageInfo.endCursor) || null : null;
  return { status: 'page', title: str(proj.title), number: typeof proj.number === 'number' ? proj.number : 0, nodes, nextCursor };
}

const keyOf = (repo: string, number: number): string => `${repo}#${number}`;

/** How eligibility is decided: the approval Issue Field and the values that qualify. */
export interface EligibilityGate {
  /** The Issue Field to read (e.g. "Approved for Development"). */
  approvalField: string;
  /** The field values that make an initiative eligible (e.g. ["Approved"]). */
  eligibleValues: readonly string[];
}

/**
 * Group raw nodes (across all pages) into initiatives + their cross-repo
 * children, and mark eligibility off the initiative's approval Issue Field.
 *
 * A node with no parent (or whose parent isn't on the board) is a top-level
 * initiative; a node whose parent IS on the board is that initiative's child.
 * A single-repo item is simply an initiative with no children.
 */
export function buildBoard(
  nodes: readonly RawBoardNode[],
  meta: { title: string; number: number },
  gate: EligibilityGate,
): BoardProject {
  const toItem = (n: RawBoardNode): BoardItem => ({
    number: n.number,
    title: n.title,
    repo: n.repo,
    state: n.state,
    status: n.status,
    approval: n.issueFields[gate.approvalField] ?? null,
    priority: n.issueFields['Priority'] ?? null,
    url: n.url,
    assignees: n.assignees,
  });

  const present = new Set(nodes.map((n) => keyOf(n.repo, n.number)));
  const childrenByParent = new Map<string, BoardItem[]>();
  const topLevel: RawBoardNode[] = [];
  for (const n of nodes) {
    const parentKey = n.parent ? keyOf(n.parent.repo, n.parent.number) : null;
    if (parentKey && present.has(parentKey)) {
      childrenByParent.set(parentKey, [...(childrenByParent.get(parentKey) ?? []), toItem(n)]);
    } else {
      topLevel.push(n);
    }
  }

  const initiatives: BoardInitiative[] = topLevel.map((n) => {
    const item = toItem(n);
    const children = childrenByParent.get(keyOf(n.repo, n.number)) ?? [];
    // An initiative's scope is its CHILDREN's repos: each work repo contributes a
    // child issue, and the scope is exactly those repos. The initiative's own
    // repo counts only when it has a child there -- so an umbrella/tracking issue
    // filed in a hub repo (a coordination or docs repo that does no work for this
    // initiative) does not force that repo to become an owner with nothing to
    // implement, spawning a worktree and a gate that open an empty PR. A childless
    // item is a single-repo initiative: its scope is its own repo.
    const childRepos = children.map((c) => c.repo);
    const repos = childRepos.length > 0 ? [...new Set(childRepos)] : [item.repo];
    // Eligible: the initiative's "Approved for Development" value is one of the
    // gate values, and it isn't already closed/done. Children carry their own
    // progress; the gate is on the initiative you start, and the in-app manifest
    // is the real human checkpoint before anything drives.
    const eligible = item.approval !== null && gate.eligibleValues.includes(item.approval) && item.state !== 'CLOSED';
    return { item, children, repos, eligible };
  });

  return { title: meta.title, number: meta.number, initiatives };
}
