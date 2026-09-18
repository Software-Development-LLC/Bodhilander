/**
 * Board-initiate decision tests (CO-722, Phase 4).
 *
 * The pure part of "Initiate from the board": derive the tracking key from an
 * initiative's title, and refuse (never guess) when the initiative is gone, not
 * eligible, or has no [KEY-N] title. The side-effecting `initiateFromBoard`
 * (board fetch + createRun) is thin over this.
 *
 * Run with: bun test src/main/run-engine/__tests__/board-initiate.test.ts
 */
import { describe, expect, test, mock } from 'bun:test';
import type { BoardResult, BoardInitiative } from '../../../shared/types';

// run-loop-service transitively reaches electron/electron-log at import; the
// helpers under test are pure, so stub those two and import dynamically.
mock.module('electron', () => ({ app: { getPath: () => '/nonexistent-userdata', isPackaged: false, getAppPath: () => '/app' } }));
mock.module('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }));
const { boardInitiativeKey, planBoardInitiate } = await import('../run-loop-service');

const initiative = (over: Partial<BoardInitiative['item']> & { repos?: string[]; eligible?: boolean } = {}): BoardInitiative => ({
  item: {
    number: over.number ?? 838, repo: over.repo ?? 'bodhi-code', title: over.title ?? '[CO-838] Do a thing',
    state: 'OPEN', status: 'Todo', approval: 'Approved', priority: null, url: 'u', assignees: [],
  },
  children: [],
  repos: over.repos ?? ['bodhi-service-api', 'bodhi-service-insights'],
  eligible: over.eligible ?? true,
});

const board = (initiatives: BoardInitiative[]): BoardResult =>
  ({ status: 'ok', project: { title: 'Bodhi Pulse', number: 17, initiatives } });

describe('boardInitiativeKey', () => {
  test('extracts the [KEY-N] prefix from a title', () => {
    expect(boardInitiativeKey('[CO-838] Surface a build id')).toBe('CO-838');
    expect(boardInitiativeKey('[BSA-4275] Mirror domain timezone')).toBe('BSA-4275');
  });
  test('returns null when there is no [KEY-N] prefix', () => {
    expect(boardInitiativeKey('Just a plain title')).toBeNull();
    expect(boardInitiativeKey('(CO-1) wrong brackets')).toBeNull();
  });
});

describe('planBoardInitiate', () => {
  test('an eligible initiative yields its key and child repos', () => {
    const p = planBoardInitiate(board([initiative()]), 'bodhi-code', 838);
    expect(p.status).toBe('ok');
    if (p.status !== 'ok') throw new Error('unreachable');
    expect(p.key).toBe('CO-838');
    expect(p.repos).toEqual(['bodhi-service-api', 'bodhi-service-insights']);
  });

  test('a board that could not be read is refused with the reason', () => {
    const p = planBoardInitiate({ status: 'problem', problem: 'no project scope' }, 'bodhi-code', 838);
    expect(p.status).toBe('refused');
    if (p.status !== 'refused') throw new Error('unreachable');
    expect(p.refusals[0].fix).toContain('no project scope');
  });

  test('an initiative not on the board is refused', () => {
    const p = planBoardInitiate(board([initiative()]), 'bodhi-code', 999);
    expect(p.status).toBe('refused');
    if (p.status !== 'refused') throw new Error('unreachable');
    expect(p.refusals[0].what).toContain('not on the board');
  });

  test('an ineligible initiative is refused (approve it first)', () => {
    const p = planBoardInitiate(board([initiative({ eligible: false })]), 'bodhi-code', 838);
    expect(p.status).toBe('refused');
    if (p.status !== 'refused') throw new Error('unreachable');
    expect(p.refusals[0].what).toContain('not eligible');
  });

  test('an initiative with no [KEY-N] title is refused rather than guessed', () => {
    const p = planBoardInitiate(board([initiative({ title: 'no key here' })]), 'bodhi-code', 838);
    expect(p.status).toBe('refused');
    if (p.status !== 'refused') throw new Error('unreachable');
    expect(p.refusals[0].what).toContain('no [KEY-N] title');
  });
});
