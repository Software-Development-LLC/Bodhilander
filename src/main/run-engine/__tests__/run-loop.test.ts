import { describe, expect, test } from 'bun:test';
import type { RunGateRow, RunOwnerRow, RunRow } from '../../repositories/runs';
import type { GateLook } from '../attention-pass';
import { createRunLoop, schedulingState, type LoopDeps } from '../run-loop';
import { CHECKS_INTERVAL_MS, ESCALATE_AFTER, GATE_INTERVAL_MS } from '../reconcile-loop';
import type { RunEvent } from '../transitions';

const T0 = Date.parse('2026-09-15T03:00:00Z');

function run(id: string, state: RunRow['state']): RunRow {
  return {
    id, initiativeKey: 'BDH-239', initiativeDir: 'C:/init', harnessPath: 'C:/h', bodhiRoot: 'C:/r',
    pythonPath: null, state, permissionPosture: 'manual', budgetUsd: null, groupId: null, blockedReason: null,
    createdAt: new Date(T0),
  } as RunRow;
}

function owner(runId: string, over: Partial<RunOwnerRow> = {}): RunOwnerRow {
  return {
    runId, repo: 'Bodhilander', worktree: 'C:/wt', branch: 'feat/x', base: 'origin/development', scratch: null,
    agent: 'bodhilander-lead', status: 'pending', prNumber: null, prUrl: null, ...over,
  };
}

const GATE: RunGateRow = {
  id: 'g', runId: 'r1', repo: 'Bodhilander', gate: 2, agent: 'bodhilander-lead', attempt: 1, bgSessionId: 'abc', claudeSessionId: 'abc-0',
  status: 'running', verdictJson: null, posture: 'manual', startedAt: '2026-09-15 02:50:00',
};

function look(event: RunEvent | null, note = event ? 'decided' : null): GateLook {
  return {
    gate: 2, agent: 'bodhilander-lead', attempt: 1, receiptPath: 'p', receiptVerdict: event ? 'pass' : null,
    status: event ? 'gone' : 'busy', statusNote: null, runningForMs: 1000, attention: { event, note },
  };
}

interface Fake {
  deps: LoopDeps;
  calls: string[];
  now: { t: number };
}

function fake(over: Partial<LoopDeps> & { runs?: RunRow[]; owners?: Record<string, RunOwnerRow[]> } = {}): Fake {
  const calls: string[] = [];
  const now = { t: T0 };
  const runs = over.runs ?? [];
  // By default one owner per run, whose per-owner state IS the run's state --
  // the single-owner case, so these tests read as they did before the fan-out.
  // A multi-owner test passes `owners` explicitly.
  const owners = over.owners ?? Object.fromEntries(
    runs.map((r) => [r.id, [owner(r.id, { state: r.state })]]),
  );
  const deps: LoopDeps = {
    now: () => now.t,
    listActiveRuns: () => runs,
    listOwners: (id) => owners[id] ?? [],
    activeGate: () => GATE,
    look: async () => { calls.push('look'); return look(null); },
    pending: () => 0,
    discoverPr: async () => { calls.push('discover'); return { number: 299, url: 'https://github.com/o/r/pull/299' }; },
    recordPr: (_r, _o, pr) => { calls.push(`record:${pr.number}`); },
    reconcile: async (_r, t) => { calls.push(`reconcile:${t.repo}#${t.prNumber}:${t.state}`); return { events: [], problems: [] }; },
    advance: async (_r, _o, e) => { calls.push(`advance:${e.kind}`); return { state: 'running', applied: [e], problems: [], notifications: [], released: false, runaway: null }; },
    startOwner: async (_r, o) => { calls.push(`startOwner:${o.repo}`); return { state: 'running', applied: [], problems: [], notifications: [], released: false, runaway: null }; },
    approvers: () => ['brannon-bowden'],
    log: (line) => { calls.push(`log:${line.slice(0, 40)}`); },
    ...over,
  };
  return { deps, calls, now };
}

describe('what a tick does to a running run', () => {
  test('looks at the gate, and applies what attention decided', async () => {
    const f = fake({
      runs: [run('r1', 'running')],
      look: async () => look({ kind: 'gateFinished', gate: 2, verdict: 'pass' }),
    });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    expect(report.due).toEqual(['r1']);
    expect(report.looked).toEqual([{ runId: 'r1', gate: 2, agent: 'bodhilander-lead', decided: 'gateFinished' }]);
    expect(f.calls).toContain('advance:gateFinished');
  });

  test('a busy gate is looked at and left alone, and that counts as a pass', async () => {
    const f = fake({ runs: [run('r1', 'running')] });
    const loop = createRunLoop(f.deps);
    await loop.tick();
    expect(f.calls.filter((c) => c.startsWith('advance'))).toEqual([]);
    // A pass that established "the gate is busy" is a pass. Only problems
    // count against the cadence.
    expect(loop.schedule().get('r1')?.failures).toBe(0);
    expect(loop.schedule().get('r1')?.lastPassAt).toBe(T0);
  });

  test('running with no gate row is skipped and counted', async () => {
    const f = fake({ runs: [run('r1', 'running')], activeGate: () => null });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    expect(report.skipped[0]?.why).toContain('no gate row');
    expect(loop.schedule().get('r1')?.failures).toBe(1);
  });
});

describe('a running gate with a permission request waiting', () => {
  test('moves the run to a person, whatever the daemon says the session is doing', async () => {
    // The hook holds the blocked tool, so the session reads busy; only the
    // request file says a person is needed. Pending must win over attention.
    const f = fake({ runs: [run('r1', 'running')], pending: () => 2 });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    expect(f.calls).toContain('advance:permissionRequested');
    // Attention is not even consulted when a request is pending.
    expect(f.calls).not.toContain('look');
    expect(report.looked[0]?.decided).toBe('permissionRequested');
  });

  test('with nothing pending, the attention pass decides as before', async () => {
    const f = fake({ runs: [run('r1', 'running')], pending: () => 0 });
    await createRunLoop(f.deps).tick();
    expect(f.calls).toContain('look');
    expect(f.calls).not.toContain('advance:permissionRequested');
  });
});

describe('what a tick does to a run waiting on GitHub', () => {
  test('finds the PR by branch when the run does not know it, records it, then reconciles by slug', async () => {
    // The scribe opened the PR and nothing told the engine which. The branch
    // is the one thing the run knows; gh finds the PR from it, and the slug
    // comes from the PR's own URL -- the registry knows paths, not slugs.
    const f = fake({ runs: [run('r1', 'waitingChecks')], owners: { r1: [owner('r1', { state: 'waitingChecks' })] } });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    expect(f.calls).toEqual(expect.arrayContaining(['discover', 'record:299', 'reconcile:o/r#299:waitingChecks']));
    expect(report.reconciled).toEqual([{ runId: 'r1', events: [] }]);
  });

  test('a run that already knows its PR is not asked again', async () => {
    const f = fake({
      runs: [run('r1', 'waitingReview')],
      owners: { r1: [owner('r1', { state: 'waitingReview', prNumber: 12, prUrl: 'https://github.com/o/r/pull/12' })] },
    });
    await createRunLoop(f.deps).tick();
    expect(f.calls).not.toContain('discover');
    expect(f.calls).toContain('reconcile:o/r#12:waitingReview');
  });

  test('no PR yet is a skip and a failure, not a state', async () => {
    // The scribe may not have opened it. Asking again later is right;
    // deciding anything now is not.
    const f = fake({ runs: [run('r1', 'waitingChecks')], owners: { r1: [owner('r1', { state: 'waitingChecks' })] }, discoverPr: async () => null });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    expect(report.skipped[0]?.why).toContain('no PR found');
    expect(f.calls.filter((c) => c.startsWith('reconcile'))).toEqual([]);
    expect(loop.schedule().get('r1')?.failures).toBe(1);
  });

  test('every event reconcile returns is applied, in order', async () => {
    const f = fake({
      runs: [run('r1', 'waitingChecks')],
      owners: { r1: [owner('r1', { state: 'waitingChecks', prNumber: 1, prUrl: 'https://github.com/o/r/pull/1' })] },
      reconcile: async () => ({ events: [{ kind: 'checksGreen' }, { kind: 'reviewRequested' }], problems: [] }),
    });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    expect(f.calls.filter((c) => c.startsWith('advance'))).toEqual(['advance:checksGreen', 'advance:reviewRequested']);
    expect(report.reconciled[0]?.events).toEqual(['checksGreen', 'reviewRequested']);
  });

  test('a reconcile problem is reported and counted, and the run stays where it is', async () => {
    const f = fake({
      runs: [run('r1', 'waitingChecks')],
      owners: { r1: [owner('r1', { state: 'waitingChecks', prNumber: 1, prUrl: 'https://github.com/o/r/pull/1' })] },
      reconcile: async () => ({ events: [], problems: ['gh could not read o/r#1: no network'] }),
    });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    expect(report.problems[0]?.problem).toContain('no network');
    expect(loop.schedule().get('r1')?.failures).toBe(1);
  });
});

describe('the schedule', () => {
  test('a run is not looked at again before its cadence, and is after it', async () => {
    const f = fake({ runs: [run('r1', 'running')] });
    const loop = createRunLoop(f.deps);
    await loop.tick();
    f.now.t = T0 + GATE_INTERVAL_MS - 1;
    expect((await loop.tick()).due).toEqual([]);
    f.now.t = T0 + GATE_INTERVAL_MS;
    expect((await loop.tick()).due).toEqual(['r1']);
  });

  test('failures back the run off, and the threshold is announced exactly once', async () => {
    const f = fake({ runs: [run('r1', 'running')], activeGate: () => null });
    const loop = createRunLoop(f.deps);
    const escalations: number[] = [];
    for (let i = 1; i <= ESCALATE_AFTER + 2; i += 1) {
      // Far enough ahead that even the backed-off interval has elapsed.
      f.now.t = T0 + i * 24 * 60 * 60 * 1000;
      const report = await loop.tick();
      if (report.escalated.length) escalations.push(i);
    }
    expect(escalations).toEqual([ESCALATE_AFTER]);
    expect(loop.schedule().get('r1')?.failures).toBe(ESCALATE_AFTER + 2);
  });

  test('a run that is no longer active is forgotten', async () => {
    const runs = [run('r1', 'running')];
    const f = fake({ runs });
    const loop = createRunLoop(f.deps);
    await loop.tick();
    expect(loop.schedule().has('r1')).toBe(true);
    runs.length = 0;
    await loop.tick();
    expect(loop.schedule().has('r1')).toBe(false);
  });

  test('a run waiting on a person is never due', async () => {
    const f = fake({ runs: [run('r1', 'waitingPermission'), run('r2', 'inconclusive')] });
    const report = await createRunLoop(f.deps).tick();
    expect(report.due).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  test('a throw inside one run’s pass is that run’s problem, not the tick’s', async () => {
    const f = fake({
      runs: [run('r1', 'running'), run('r2', 'running')],
      look: async (r) => { if (r.id === 'r1') throw new Error('the daemon hung up'); return look(null); },
    });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    expect(report.problems).toEqual([{ runId: 'r1', problem: 'the daemon hung up' }]);
    expect(report.due).toEqual(['r1', 'r2']);
    expect(loop.schedule().get('r1')?.failures).toBe(1);
    expect(loop.schedule().get('r2')?.failures).toBe(0);
  });

  test('the checks cadence is a minute, so a reconciled run is due again in one', async () => {
    const f = fake({ runs: [run('r1', 'waitingChecks')], owners: { r1: [owner('r1', { state: 'waitingChecks', prNumber: 1, prUrl: 'https://github.com/o/r/pull/1' })] } });
    const loop = createRunLoop(f.deps);
    await loop.tick();
    f.now.t = T0 + CHECKS_INTERVAL_MS;
    expect((await loop.tick()).due).toEqual(['r1']);
  });
});

describe('a tick survives what a per-run catch cannot', () => {
  test('a throw from listActiveRuns is the tick’s reported problem, not a rejection', async () => {
    // The scheduling calls sit above the per-run try/catch. Unguarded, a
    // transient store error becomes an unhandled rejection that kills
    // unattended operation. The tick must resolve with the problem recorded.
    const f = fake({ listActiveRuns: () => { throw new Error('database is locked'); } });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    expect(report.problems).toEqual([{ runId: '(scheduler)', problem: 'database is locked' }]);
    expect(report.due).toEqual([]);
  });

  test('a throw from dueRuns is caught the same way', async () => {
    // listActiveRuns is fine; the memory the scheduler builds from it is
    // what throws. Same guarantee.
    const f = fake({ runs: [run('r1', 'running')], now: undefined });
    // now() is called by dueRuns via intervalFor; make it throw.
    f.deps.now = () => { throw new Error('clock unavailable'); };
    const report = await createRunLoop(f.deps).tick();
    expect(report.problems.some((p) => p.runId === '(scheduler)' && p.problem.includes('clock'))).toBe(true);
  });
});

describe('the timer', () => {
  test('a slow tick does not start a second before the first finishes', async () => {
    // The whole reason for the ticking guard. Two overlapping ticks would
    // drive the same run twice and race its rows.
    let inFlight = 0;
    let maxConcurrent = 0;
    let ticks = 0;
    let release: (() => void) | null = null;
    const f = fake({
      runs: [run('r1', 'running')],
      look: async () => {
        ticks += 1;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise<void>((resolve) => { release = resolve; });
        inFlight -= 1;
        return look(null);
      },
    });
    const loop = createRunLoop(f.deps);
    loop.start(1); // fire faster than the tick can finish
    await new Promise((r) => setTimeout(r, 30)); // several timer fires
    expect(ticks).toBe(1); // only the first got in; the rest were suppressed
    expect(maxConcurrent).toBe(1);
    release?.();
    loop.stop();
  });
});

describe('driving a run with several owners (multi-owner)', () => {
  test('drives every movable owner in one pass, each on its own state', async () => {
    const f = fake({
      runs: [run('r1', 'running')],
      owners: {
        r1: [
          owner('r1', { repo: 'repo-a', state: 'running' }),
          owner('r1', { repo: 'repo-b', state: 'waitingChecks', prNumber: 7, prUrl: 'https://github.com/o/b/pull/7' }),
        ],
      },
      look: async () => look({ kind: 'gateFinished', gate: 2, verdict: 'pass' }),
    });
    const loop = createRunLoop(f.deps);
    await loop.tick();
    // repo-a looked at its gate; repo-b reconciled its PR. No >1-owner skip.
    expect(f.calls).toContain('advance:gateFinished');
    expect(f.calls.some((c) => c.startsWith('reconcile:o/b#7'))).toBe(true);
    expect(f.calls.some((c) => c.includes('this slice drives one repo'))).toBe(false);
  });

  test('one owner’s reconcile problem does not stop the other owner reconciling', async () => {
    // The ok = (await ...) && ok aggregation must not short-circuit: repo-a's
    // gh failing is repo-a's failure, and repo-b's PR is still reconciled.
    const seen: string[] = [];
    const f = fake({
      runs: [run('r1', 'waitingChecks')],
      owners: {
        r1: [
          owner('r1', { repo: 'repo-a', state: 'waitingChecks', prNumber: 1, prUrl: 'https://github.com/o/a/pull/1' }),
          owner('r1', { repo: 'repo-b', state: 'waitingChecks', prNumber: 2, prUrl: 'https://github.com/o/b/pull/2' }),
        ],
      },
      reconcile: async (_r, t) => {
        seen.push(t.repo);
        return t.repo === 'o/a' ? { events: [], problems: ['gh could not read o/a#1'] } : { events: [], problems: [] };
      },
    });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    // Both reconciled despite repo-a failing; the run's pass counts a failure.
    expect(seen).toEqual(expect.arrayContaining(['o/a', 'o/b']));
    expect(report.problems.some((p) => p.problem.includes('o/a#1'))).toBe(true);
    expect(loop.schedule().get('r1')?.failures).toBe(1);
  });

  test('a stuck owner does not stop the run being scheduled or the others moving', async () => {
    // THE STARVATION REGRESSION. The rollup is a person-state (inconclusive
    // outranks running), which has a null interval -- so if the loop scheduled
    // off the rollup, this run would never be due again and the healthy owner
    // would starve. Scheduling reads the fastest movable owner instead.
    const f = fake({
      runs: [run('r1', 'inconclusive')],
      owners: {
        r1: [
          owner('r1', { repo: 'repo-a', state: 'inconclusive', blockedReason: 'gate 2 could not establish' }),
          owner('r1', { repo: 'repo-b', state: 'running' }),
        ],
      },
      look: async () => look({ kind: 'gateFinished', gate: 2, verdict: 'pass' }),
    });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    expect(report.due).toContain('r1');
    // repo-b moved; repo-a (inconclusive) was left for the inbox.
    expect(f.calls).toContain('advance:gateFinished');
  });
});

describe('scheduling a run off its fastest owner', () => {
  test('picks the shortest-interval movable owner, ignoring the rollup', () => {
    expect(schedulingState(['inconclusive', 'running'], 'inconclusive')).toBe('running');
    // checks (60s) is faster than review (5m).
    expect(schedulingState(['waitingReview', 'waitingChecks'], 'waitingReview')).toBe('waitingChecks');
    expect(schedulingState(['approved', 'waitingReview'], 'approved')).toBe('waitingReview');
  });

  test('falls back to the run state when no owner can move, so the run is not due', () => {
    // waitingPermission and approved are both non-movable; the fallback's null
    // interval keeps the run out of dueRuns.
    expect(schedulingState(['waitingPermission', 'approved'], 'waitingPermission')).toBe('waitingPermission');
    expect(schedulingState([null, null], 'preparing')).toBe('preparing');
  });
});

describe('starting a run that has been armed but never run (CO-722)', () => {
  test('a preparing run provisions once by advancing its first owner with prepared', async () => {
    const f = fake({
      runs: [run('r1', 'preparing')],
      owners: { r1: [owner('r1', { repo: 'repo-a', state: null }), owner('r1', { repo: 'repo-b', state: null })] },
    });
    const report = await createRunLoop(f.deps).tick();
    expect(report.due).toContain('r1');
    // Provision runs once, via the first owner's bootstrap -- not per owner.
    expect(f.calls).toEqual(['advance:prepared']);
  });

  test('a null-state owner of a running run is started at its gate 2', async () => {
    // The first owner rode the provision and is running; the second was left
    // null and must be brought onto its own track.
    const f = fake({
      runs: [run('r1', 'running')],
      owners: {
        r1: [
          owner('r1', { repo: 'repo-a', state: 'running' }),
          owner('r1', { repo: 'repo-b', state: null }),
        ],
      },
    });
    await createRunLoop(f.deps).tick();
    expect(f.calls).toContain('startOwner:repo-b');
    // repo-a (already running) is looked at, not re-started.
    expect(f.calls).not.toContain('startOwner:repo-a');
    expect(f.calls).toContain('look');
  });

  test('a preparing run is due immediately, and stays due while an owner is unstarted', () => {
    // schedulingState maps a null owner to the preparing cadence, so a run with
    // an unstarted owner keeps ticking even once its started owners settle.
    expect(schedulingState([null, null], 'preparing')).toBe('preparing');
    expect(schedulingState(['approved', null], 'approved')).toBe('preparing');
    expect(schedulingState(['approved', 'done'], 'approved')).toBe('approved');
  });
});
