import { describe, expect, test } from 'bun:test';
import type { BoardInitiative, BoardItem, BoardResult, RunCrossRepoPrepareResult } from '../../../shared/types';
import {
  createBoardWatcher,
  initiativeKeyOf,
  priorityRank,
  selectCandidates,
  startBudget,
  watchTick,
  type BoardWatcherDeps,
} from '../board-watcher';

function item(over: Partial<BoardItem> = {}): BoardItem {
  return {
    number: 1, title: '[CO-1] a thing', repo: 'bodhi-code', state: 'OPEN', status: null,
    approval: 'Approved', priority: null, url: 'https://github.com/o/bodhi-code/issues/1', assignees: [], ...over,
  };
}

function initiative(over: Partial<BoardInitiative> = {}): BoardInitiative {
  const it = over.item ?? item();
  return { item: it, children: [], repos: over.repos ?? [it.repo], eligible: true, inProgress: false, ...over };
}

function board(initiatives: BoardInitiative[]): BoardResult {
  return { status: 'ok', project: { title: 'Board', number: 17, initiatives } };
}

const prepared = (runId: string): RunCrossRepoPrepareResult => ({ status: 'prepared', runId });
const refused = (what: string): RunCrossRepoPrepareResult => ({ status: 'refused', refusals: [{ what, fix: 'x' }] });

function deps(over: Partial<BoardWatcherDeps> = {}): BoardWatcherDeps {
  return {
    now: () => 1_000_000_000_000,
    enabled: () => true,
    projectNumber: () => 17,
    perDayCap: () => null,
    maxConcurrent: () => 6,
    readBoard: async () => board([initiative()]),
    countActiveRuns: () => 0,
    countRunsCreatedSince: () => 0,
    hasRunForKey: () => false,
    startRun: (key) => prepared(`run-${key}`),
    log: () => {},
    ...over,
  };
}

describe('initiativeKeyOf', () => {
  test('pulls [KEY-N] from a title, or null when absent', () => {
    expect(initiativeKeyOf('[CO-838] board flow')).toBe('CO-838');
    expect(initiativeKeyOf('no key here')).toBeNull();
    expect(initiativeKeyOf('[123-4] leading digit is not a key')).toBeNull();
  });
});

describe('priorityRank', () => {
  test('P-scale, then words, unknown/null last', () => {
    expect(priorityRank('P0')).toBe(0);
    expect(priorityRank('p2')).toBe(2);
    expect(priorityRank('High')).toBe(1);
    expect(priorityRank('low')).toBe(3);
    expect(priorityRank('whatever')).toBe(Number.POSITIVE_INFINITY);
    expect(priorityRank(null)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('selectCandidates', () => {
  test('keeps eligible, keyed, not-in-progress, never-run initiatives', () => {
    const inits = [
      initiative({ item: item({ number: 1, title: '[CO-1] ok' }) }),
      initiative({ item: item({ number: 2, title: '[CO-2] ineligible' }), eligible: false }),
      initiative({ item: item({ number: 3, title: '[CO-3] in progress' }), inProgress: true }),
      initiative({ item: item({ number: 4, title: 'no key' }) }),
      initiative({ item: item({ number: 5, title: '[CO-5] already run' }) }),
    ];
    const keys = selectCandidates(inits, (k) => k === 'CO-5').map((c) => c.key);
    expect(keys).toEqual(['CO-1']);
  });

  test('orders by priority then issue number', () => {
    const inits = [
      initiative({ item: item({ number: 30, title: '[CO-30] low', priority: 'Low' }) }),
      initiative({ item: item({ number: 20, title: '[CO-20] p0', priority: 'P0' }) }),
      initiative({ item: item({ number: 10, title: '[CO-10] p0 older', priority: 'P0' }) }),
      initiative({ item: item({ number: 40, title: '[CO-40] none', priority: null }) }),
    ];
    expect(selectCandidates(inits, () => false).map((c) => c.key)).toEqual(['CO-10', 'CO-20', 'CO-30', 'CO-40']);
  });

  test('carries the initiative repos through', () => {
    const inits = [initiative({ item: item({ title: '[CO-9] x' }), repos: ['api', 'insights'] })];
    expect(selectCandidates(inits, () => false)[0]?.repos).toEqual(['api', 'insights']);
  });
});

describe('startBudget', () => {
  test('the smaller of the concurrency and per-day budgets, floored at zero', () => {
    expect(startBudget(0, 6, 0, null)).toBe(6);          // unlimited day -> concurrency wins
    expect(startBudget(4, 6, 0, null)).toBe(2);          // 2 slots left
    expect(startBudget(0, 6, 3, 5)).toBe(2);             // 5/day, 3 spent -> 2
    expect(startBudget(5, 6, 0, 10)).toBe(1);            // concurrency is the tighter cap
    expect(startBudget(6, 6, 0, null)).toBe(0);          // at concurrency cap
    expect(startBudget(0, 6, 10, 5)).toBe(0);            // over the day cap
    expect(startBudget(0, 6, 0, 0)).toBe(6);             // 0 per-day means unlimited
  });
});

describe('watchTick', () => {
  test('does nothing while auto-drive is off', async () => {
    const started: string[] = [];
    const report = await watchTick(deps({ enabled: () => false, startRun: (k) => { started.push(k); return prepared(k); } }));
    expect(report.skipped).toBe('auto-drive is off');
    expect(started).toEqual([]);
  });

  test('skips when no project is configured', async () => {
    const report = await watchTick(deps({ projectNumber: () => null }));
    expect(report.skipped).toBe('no project configured');
  });

  test('skips (never throws) when the board cannot be read', async () => {
    const report = await watchTick(deps({ readBoard: async () => ({ status: 'problem', problem: 'gh 403' }) }));
    expect(report.skipped).toContain('gh 403');
    expect(report.started).toEqual([]);
  });

  test('skips (never throws) when the board read itself throws', async () => {
    const report = await watchTick(deps({ readBoard: async () => { throw new Error('network down'); } }));
    expect(report.skipped).toContain('network down');
  });

  test('starts every eligible initiative when the budget is ample', async () => {
    const inits = [
      initiative({ item: item({ number: 1, title: '[CO-1] a' }) }),
      initiative({ item: item({ number: 2, title: '[CO-2] b' }) }),
    ];
    const report = await watchTick(deps({ readBoard: async () => board(inits) }));
    expect(report.started.map((s) => s.key)).toEqual(['CO-1', 'CO-2']);
  });

  test('stops at the concurrency cap and holds the rest', async () => {
    const inits = [
      initiative({ item: item({ number: 1, title: '[CO-1] a', priority: 'P0' }) }),
      initiative({ item: item({ number: 2, title: '[CO-2] b', priority: 'P1' }) }),
      initiative({ item: item({ number: 3, title: '[CO-3] c', priority: 'P2' }) }),
    ];
    // 6 max, 5 already active -> exactly one slot.
    const report = await watchTick(deps({ readBoard: async () => board(inits), maxConcurrent: () => 6, countActiveRuns: () => 5 }));
    expect(report.started.map((s) => s.key)).toEqual(['CO-1']);
    expect(report.held.map((h) => h.key)).toEqual(['CO-2', 'CO-3']);
  });

  test('stops at the per-day cap', async () => {
    const inits = [
      initiative({ item: item({ number: 1, title: '[CO-1] a' }) }),
      initiative({ item: item({ number: 2, title: '[CO-2] b' }) }),
    ];
    // 3/day, 2 already created today -> one slot.
    const report = await watchTick(deps({ readBoard: async () => board(inits), perDayCap: () => 3, countRunsCreatedSince: () => 2 }));
    expect(report.started.map((s) => s.key)).toEqual(['CO-1']);
    expect(report.held.map((h) => h.key)).toEqual(['CO-2']);
  });

  test('a refusal holds that initiative WITHOUT spending budget', async () => {
    const inits = [
      initiative({ item: item({ number: 1, title: '[CO-1] refuses' }) }),
      initiative({ item: item({ number: 2, title: '[CO-2] ok' }) }),
    ];
    // One slot only; the first refuses, so the slot must still go to the second.
    const report = await watchTick(deps({
      readBoard: async () => board(inits),
      maxConcurrent: () => 1,
      startRun: (k) => (k === 'CO-1' ? refused('config missing') : prepared(`run-${k}`)),
    }));
    expect(report.started.map((s) => s.key)).toEqual(['CO-2']);
    expect(report.held.find((h) => h.key === 'CO-1')?.why).toContain('config missing');
  });

  test('does not re-start a key that already has a run', async () => {
    const inits = [initiative({ item: item({ title: '[CO-1] a' }) })];
    const started: string[] = [];
    const report = await watchTick(deps({
      readBoard: async () => board(inits),
      hasRunForKey: () => true,
      startRun: (k) => { started.push(k); return prepared(k); },
    }));
    expect(started).toEqual([]);
    expect(report.started).toEqual([]);
  });

  test('the trailing-24h window is measured from now', async () => {
    let since = 0;
    await watchTick(deps({ now: () => 5_000_000_000, countRunsCreatedSince: (s) => { since = s; return 0; }, perDayCap: () => 5 }));
    expect(since).toBe(5_000_000_000 - 24 * 60 * 60 * 1000);
  });
});

describe('createBoardWatcher', () => {
  test('a slow tick is not re-entered by the next timer fire', async () => {
    let entered = 0;
    let release: (() => void) | null = null;
    const w = createBoardWatcher(deps({
      readBoard: async () => {
        entered += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return board([]);
      },
    }));
    w.start(1); // fire far faster than the tick resolves
    await new Promise((r) => setTimeout(r, 30));
    expect(entered).toBe(1); // the overlap guard held
    release?.();
    w.stop();
  });

  test('a throwing tick is swallowed so the timer survives', async () => {
    const w = createBoardWatcher(deps({ enabled: () => { throw new Error('boom'); } }));
    const report = await w.tick();
    expect(report.skipped).toBe('tick failed');
  });
});
