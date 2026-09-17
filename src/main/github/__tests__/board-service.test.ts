/**
 * Board service tests (board-driven orchestration, Phase 1).
 *
 * The side-effecting orchestration around the pure reader: config refusals,
 * a non-zero `gh` exit, a GraphQL problem mid-pagination, multi-page
 * accumulation, the project-number override, and the page cap — all the branches
 * where pagination + error propagation actually happen. `gh` and config are
 * injected, so no real `gh` or DB is in the room.
 *
 * Run with: bun test src/main/github/__tests__/board-service.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { readProjectBoard, type BoardDeps } from '../board-service';
import type { CommandResult } from '../../run-engine/reconcile';

const issue = (number: number, repo = 'bodhi-code', status: string | null = 'Approved') => ({
  content: { __typename: 'Issue', number, title: `#${number}`, state: 'OPEN', url: 'u', repository: { name: repo }, parent: null, assignees: { nodes: [] } },
  status: status ? { name: status } : null,
});

function page(nodes: unknown[], hasNextPage = false, endCursor = 'C'): string {
  return JSON.stringify({ data: { organization: { projectV2: {
    title: 'Bodhi Pulse', number: 17, items: { pageInfo: { hasNextPage, endCursor }, nodes },
  } } } });
}

const okGh = (stdout: string): BoardDeps['gh'] => async () => ({ code: 0, stdout, stderr: '' });

function deps(gh: BoardDeps['gh'], over: Partial<BoardDeps> = {}): BoardDeps {
  return { gh, org: 'Software-Development-LLC', defaultProject: 17, approvedStatus: 'Approved', ...over };
}

describe('readProjectBoard', () => {
  test('no org configured is a fixable problem', async () => {
    const r = await readProjectBoard(deps(okGh(page([])), { org: null }));
    expect(r.status).toBe('problem');
    if (r.status !== 'problem') throw new Error('unreachable');
    expect(r.problem).toContain('org');
  });

  test('no project number is a fixable problem', async () => {
    const r = await readProjectBoard(deps(okGh(page([])), { defaultProject: null }));
    expect(r.status).toBe('problem');
    if (r.status !== 'problem') throw new Error('unreachable');
    expect(r.problem).toContain('project');
  });

  test('a non-zero gh exit is a problem carrying the stderr', async () => {
    const gh: BoardDeps['gh'] = async () => ({ code: 1, stdout: '', stderr: 'gh: not logged in' });
    const r = await readProjectBoard(deps(gh));
    expect(r.status).toBe('problem');
    if (r.status !== 'problem') throw new Error('unreachable');
    expect(r.problem).toContain('not logged in');
  });

  test('a GraphQL problem mid-read propagates (never a partial ok)', async () => {
    const r = await readProjectBoard(deps(okGh(JSON.stringify({ data: null, errors: [{ message: 'Bad credentials' }] }))));
    expect(r.status).toBe('problem');
    if (r.status !== 'problem') throw new Error('unreachable');
    expect(r.problem).toContain('Bad credentials');
  });

  test('accumulates items across pages', async () => {
    let call = 0;
    const gh: BoardDeps['gh'] = async () => {
      call += 1;
      return call === 1
        ? { code: 0, stdout: page([issue(1)], true, 'C1'), stderr: '' } satisfies CommandResult
        : { code: 0, stdout: page([issue(2)], false), stderr: '' };
    };
    const r = await readProjectBoard(deps(gh));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.project.initiatives.map((i) => i.item.number).sort()).toEqual([1, 2]);
    expect(call).toBe(2);
  });

  test('a project-number argument overrides the configured default', async () => {
    let seen = '';
    const gh: BoardDeps['gh'] = async (argv) => { seen = argv.find((a) => a.startsWith('number=')) ?? ''; return { code: 0, stdout: page([]), stderr: '' }; };
    await readProjectBoard(deps(gh), 42);
    expect(seen).toBe('number=42');
  });

  test('hitting the page cap with more to fetch is a problem, not a short list', async () => {
    // Always another page → the loop stops at the cap with a cursor still set.
    const gh: BoardDeps['gh'] = async () => ({ code: 0, stdout: page([issue(1)], true, 'MORE'), stderr: '' });
    const r = await readProjectBoard(deps(gh));
    expect(r.status).toBe('problem');
    if (r.status !== 'problem') throw new Error('unreachable');
    expect(r.problem).toContain('more than');
  });
});
