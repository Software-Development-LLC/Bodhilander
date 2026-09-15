import { describe, expect, test } from 'bun:test';
import type { RunGateRow, RunOwnerRow, RunRow } from '../../repositories/runs';
import type { GateLook } from '../attention-pass';
import { createRunLoop, type LoopDeps } from '../run-loop';
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
  id: 'g', runId: 'r1', gate: 2, agent: 'bodhilander-lead', attempt: 1, bgSessionId: 'abc', claudeSessionId: 'abc-0',
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
  const owners = over.owners ?? {};
  const deps: LoopDeps = {
    now: () => now.t,
    listActiveRuns: () => runs,
    listOwners: (id) => owners[id] ?? [],
    activeGate: () => GATE,
    look: async () => { calls.push('look'); return look(null); },
    discoverPr: async () => { calls.push('discover'); return { number: 299, url: 'https://github.com/o/r/pull/299' }; },
    recordPr: (_r, _o, pr) => { calls.push(`record:${pr.number}`); },
    reconcile: async (_r, t) => { calls.push(`reconcile:${t.repo}#${t.prNumber}:${t.state}`); return { events: [], problems: [] }; },
    advance: async (_r, e) => { calls.push(`advance:${e.kind}`); return { state: 'running', applied: [e], problems: [], notifications: [], released: false, runaway: null }; },
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

describe('what a tick does to a run waiting on GitHub', () => {
  test('finds the PR by branch when the run does not know it, records it, then reconciles by slug', async () => {
    // The scribe opened the PR and nothing told the engine which. The branch
    // is the one thing the run knows; gh finds the PR from it, and the slug
    // comes from the PR's own URL -- the registry knows paths, not slugs.
    const f = fake({ runs: [run('r1', 'waitingChecks')], owners: { r1: [owner('r1')] } });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    expect(f.calls).toEqual(expect.arrayContaining(['discover', 'record:299', 'reconcile:o/r#299:waitingChecks']));
    expect(report.reconciled).toEqual([{ runId: 'r1', events: [] }]);
  });

  test('a run that already knows its PR is not asked again', async () => {
    const f = fake({
      runs: [run('r1', 'waitingReview')],
      owners: { r1: [owner('r1', { prNumber: 12, prUrl: 'https://github.com/o/r/pull/12' })] },
    });
    await createRunLoop(f.deps).tick();
    expect(f.calls).not.toContain('discover');
    expect(f.calls).toContain('reconcile:o/r#12:waitingReview');
  });

  test('no PR yet is a skip and a failure, not a state', async () => {
    // The scribe may not have opened it. Asking again later is right;
    // deciding anything now is not.
    const f = fake({ runs: [run('r1', 'waitingChecks')], owners: { r1: [owner('r1')] }, discoverPr: async () => null });
    const loop = createRunLoop(f.deps);
    const report = await loop.tick();
    expect(report.skipped[0]?.why).toContain('no PR found');
    expect(f.calls.filter((c) => c.startsWith('reconcile'))).toEqual([]);
    expect(loop.schedule().get('r1')?.failures).toBe(1);
  });

  test('every event reconcile returns is applied, in order', async () => {
    const f = fake({
      runs: [run('r1', 'waitingChecks')],
      owners: { r1: [owner('r1', { prNumber: 1, prUrl: 'https://github.com/o/r/pull/1' })] },
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
      owners: { r1: [owner('r1', { prNumber: 1, prUrl: 'https://github.com/o/r/pull/1' })] },
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
    const f = fake({ runs: [run('r1', 'waitingChecks')], owners: { r1: [owner('r1', { prNumber: 1, prUrl: 'https://github.com/o/r/pull/1' })] } });
    const loop = createRunLoop(f.deps);
    await loop.tick();
    f.now.t = T0 + CHECKS_INTERVAL_MS;
    expect((await loop.tick()).due).toEqual(['r1']);
  });
});
