/**
 * Board reader tests (board-driven orchestration, Phase 1).
 *
 * The riskiest early bit is the GraphQL shape + grouping, so these run against a
 * fixture shaped exactly like real `gh api graphql` output from Project #17
 * (a cross-repo initiative with per-repo children, a standalone item, a PR card
 * to skip, and a not-eligible initiative). Properties that matter: a `gh` that
 * exits 0 but returns errors / an inaccessible project is a PROBLEM (never a
 * silently empty board), children link to their initiative across repos, and
 * eligibility keys on the configured Status value.
 *
 * Run with: bun test src/main/github/__tests__/board-reader.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { boardQueryArgv, buildBoard, parseBoardPage, type RawBoardNode } from '../board-reader';

const item = (over: Partial<{
  number: number; title: string; repo: string; state: string; url: string;
  status: string | null; parent: { number: number; repo: string } | null; assignees: string[];
}> = {}) => ({
  content: {
    __typename: 'Issue',
    number: over.number ?? 1,
    title: over.title ?? 'x',
    state: over.state ?? 'OPEN',
    url: over.url ?? 'https://github.com/o/r/issues/1',
    repository: { name: over.repo ?? 'repo-a' },
    parent: over.parent ? { number: over.parent.number, repository: { name: over.parent.repo } } : null,
    assignees: { nodes: (over.assignees ?? []).map((login) => ({ login })) },
  },
  status: over.status === undefined ? { name: 'Todo' } : over.status === null ? null : { name: over.status },
});

function envelope(nodes: unknown[], hasNextPage = false, endCursor = 'C2') {
  return JSON.stringify({
    data: { organization: { projectV2: {
      title: 'Bodhi Pulse', number: 17,
      items: { pageInfo: { hasNextPage, endCursor }, nodes },
    } } },
  });
}

describe('boardQueryArgv', () => {
  test('carries org, number, and the query; omits cursor when absent', () => {
    const a = boardQueryArgv('Software-Development-LLC', 17);
    expect(a.slice(0, 6)).toEqual(['api', 'graphql', '-f', 'org=Software-Development-LLC', '-F', 'number=17']);
    expect(a).not.toContain('cursor=');
    expect(a.some((x) => x.startsWith('query='))).toBe(true);
  });
  test('includes the cursor when paginating', () => {
    const a = boardQueryArgv('org', 3, 'CURSOR');
    expect(a).toContain('cursor=CURSOR');
  });
});

describe('parseBoardPage', () => {
  test('parses issues, skips PR cards, reads status/parent/assignees', () => {
    const out = parseBoardPage(envelope([
      item({ number: 130, repo: 'bodhi-code', status: 'Approved', assignees: ['brannon-bowden'] }),
      item({ number: 2561, repo: 'bodhi-service-api', parent: { number: 130, repo: 'bodhi-code' }, status: 'Todo' }),
      { content: { __typename: 'PullRequest', number: 999 }, status: null },
    ]));
    expect(out.status).toBe('page');
    if (out.status !== 'page') throw new Error('unreachable');
    expect(out.nodes).toHaveLength(2); // PR skipped
    expect(out.nodes[0]).toMatchObject({ number: 130, repo: 'bodhi-code', status: 'Approved', assignees: ['brannon-bowden'] });
    expect(out.nodes[1].parent).toEqual({ repo: 'bodhi-code', number: 130 });
    expect(out.nextCursor).toBeNull(); // hasNextPage false
  });

  test('a next page yields its cursor', () => {
    const out = parseBoardPage(envelope([item()], true, 'NEXT'));
    if (out.status !== 'page') throw new Error('expected page');
    expect(out.nextCursor).toBe('NEXT');
  });

  test('non-JSON is a problem, not a throw', () => {
    expect(parseBoardPage('boom').status).toBe('problem');
  });

  test('a GraphQL errors[] (exit 0) is a problem', () => {
    const out = parseBoardPage(JSON.stringify({ data: null, errors: [{ message: 'Bad credentials' }] }));
    expect(out.status).toBe('problem');
    if (out.status !== 'problem') throw new Error('unreachable');
    expect(out.problem).toContain('Bad credentials');
  });

  test('an inaccessible/missing project is a problem', () => {
    const out = parseBoardPage(JSON.stringify({ data: { organization: { projectV2: null } } }));
    expect(out.status).toBe('problem');
    if (out.status !== 'problem') throw new Error('unreachable');
    expect(out.problem).toContain('project scope');
  });
});

describe('buildBoard', () => {
  const nodes: RawBoardNode[] = [
    { number: 130, title: '[CO-130][Initiative] X', repo: 'bodhi-code', state: 'OPEN', status: 'Approved', url: 'u', assignees: [], parent: null },
    { number: 2561, title: '[BSA-2561][Epic] X', repo: 'bodhi-service-api', state: 'OPEN', status: 'Todo', url: 'u', assignees: [], parent: { repo: 'bodhi-code', number: 130 } },
    { number: 141, title: '[BSI-141][Epic] X', repo: 'bodhi-service-insights', state: 'OPEN', status: 'Todo', url: 'u', assignees: [], parent: { repo: 'bodhi-code', number: 130 } },
    { number: 900, title: '[CO-900][Initiative] Done one', repo: 'bodhi-code', state: 'CLOSED', status: 'Done', url: 'u', assignees: [], parent: null },
    { number: 42, title: '[BSI-42] standalone', repo: 'bodhi-service-insights', state: 'OPEN', status: 'Approved', url: 'u', assignees: [], parent: null },
  ];

  test('groups children under their initiative across repos', () => {
    const b = buildBoard(nodes, { title: 'Bodhi Pulse', number: 17 }, ['Approved']);
    const co130 = b.initiatives.find((i) => i.item.number === 130 && i.item.repo === 'bodhi-code')!;
    expect(co130.children.map((c) => c.repo).sort()).toEqual(['bodhi-service-api', 'bodhi-service-insights']);
    expect(co130.repos.sort()).toEqual(['bodhi-code', 'bodhi-service-api', 'bodhi-service-insights']);
    // Children are NOT listed as their own initiatives.
    expect(b.initiatives.some((i) => i.item.number === 2561)).toBe(false);
  });

  test('eligibility keys on the initiative Status value, not closed', () => {
    const b = buildBoard(nodes, { title: 'x', number: 17 }, ['Approved']);
    expect(b.initiatives.find((i) => i.item.number === 130)!.eligible).toBe(true);   // Approved, OPEN
    expect(b.initiatives.find((i) => i.item.number === 900)!.eligible).toBe(false);  // Done/CLOSED
    expect(b.initiatives.find((i) => i.item.number === 42)!.eligible).toBe(true);    // single-repo, Approved
  });

  test('any of several eligible statuses qualifies; others do not', () => {
    // The zero-migration model: gate on existing statuses like "Todo"/"Ready".
    const items: RawBoardNode[] = [
      { number: 1, title: 'todo one', repo: 'r', state: 'OPEN', status: 'Todo', url: 'u', assignees: [], parent: null },
      { number: 2, title: 'ready one', repo: 'r', state: 'OPEN', status: 'Ready', url: 'u', assignees: [], parent: null },
      { number: 3, title: 'in progress', repo: 'r', state: 'OPEN', status: 'In Progress', url: 'u', assignees: [], parent: null },
      { number: 4, title: 'no status', repo: 'r', state: 'OPEN', status: null, url: 'u', assignees: [], parent: null },
    ];
    const b = buildBoard(items, { title: 'x', number: 17 }, ['Todo', 'Ready']);
    expect(b.initiatives.find((i) => i.item.number === 1)!.eligible).toBe(true);
    expect(b.initiatives.find((i) => i.item.number === 2)!.eligible).toBe(true);
    expect(b.initiatives.find((i) => i.item.number === 3)!.eligible).toBe(false);
    expect(b.initiatives.find((i) => i.item.number === 4)!.eligible).toBe(false); // null status never matches
  });

  test('a single-repo item is an initiative with no children', () => {
    const b = buildBoard(nodes, { title: 'x', number: 17 }, ['Approved']);
    const solo = b.initiatives.find((i) => i.item.number === 42)!;
    expect(solo.children).toEqual([]);
    expect(solo.repos).toEqual(['bodhi-service-insights']);
  });

  test('an orphan child (parent not on the board) is treated as top-level', () => {
    const orphan: RawBoardNode = { number: 77, title: 'orphan', repo: 'repo-x', state: 'OPEN', status: 'Approved', url: 'u', assignees: [], parent: { repo: 'gone', number: 5 } };
    const b = buildBoard([orphan], { title: 'x', number: 1 }, ['Approved']);
    expect(b.initiatives).toHaveLength(1);
    expect(b.initiatives[0].item.number).toBe(77);
  });
});
