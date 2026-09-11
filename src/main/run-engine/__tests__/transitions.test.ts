/**
 * Run state machine tests (CO-722).
 *
 * The machine is pure, so every path is assertable here rather than
 * discoverable during a run that spends real tokens. The cases that matter
 * most are the ones asserting a run does NOT advance: an inconclusive gate,
 * a bot nit, an unprovisioned worktree. Each of those, read as a pass or as a
 * failure, reproduces a defect this initiative exists to remove.
 *
 * Run with: bun test src/main/run-engine
 */
import { describe, expect, test } from 'bun:test';
import {
  IS_WORKING,
  NEEDS_A_PERSON,
  isTerminal,
  transition,
  type Gate,
  type RunEvent,
  type RunContext,
  type RunState,
} from '../transitions';

const ALL_STATES: RunState[] = [
  'preparing', 'provisioning', 'running', 'waitingPermission', 'waitingHumanGate',
  'waitingChecks', 'reviewNotRequested', 'waitingReview', 'inconclusive',
  'failed', 'approved', 'done',
];

const ALL_EVENTS: RunEvent[] = [
  { kind: 'prepared' },
  { kind: 'provisioned' },
  { kind: 'provisionFailed' },
  { kind: 'provisionUndriveable' },
  { kind: 'gateFinished', gate: 2, verdict: 'pass' },
  { kind: 'gateFinished', gate: 3, verdict: 'fail' },
  { kind: 'gateFinished', gate: 4, verdict: 'inconclusive' },
  { kind: 'permissionRequested' },
  { kind: 'permissionAnswered' },
  { kind: 'prOpened' },
  { kind: 'checksGreen' },
  { kind: 'checksFailed' },
  { kind: 'reviewRequested' },
  { kind: 'reviewApproved' },
  { kind: 'reviewChangesRequested', verdict: { actor: 'human' } },
  { kind: 'humanApprovedGate' },
  { kind: 'budgetExceeded' },
  { kind: 'merged' },
];

const gates: Gate[] = [2, 3, 4];

/**
 * transition() with a context supplying the gate in flight.
 *
 * For a gateFinished event that is the gate the event names -- which is what
 * every case below was implicitly assuming before the context existed. The
 * out-of-order cases pass their own context instead, because that assumption
 * is exactly what they exist to break.
 */
function go(state: RunState, event: RunEvent, context?: RunContext) {
  const activeGate = event.kind === 'gateFinished' ? event.gate : null;
  return transition(state, event, context ?? { activeGate });
}

describe('the happy path, single repo', () => {
  test('preparing provisions before it spawns an owner', () => {
    const d = go('preparing', { kind: 'prepared' });
    expect(d.state).toBe('provisioning');
    expect(d.actions).toEqual([{ kind: 'provision' }]);
  });

  test('gate 2 is only spawned once dependencies are in', () => {
    const d = go('provisioning', { kind: 'provisioned' });
    expect(d.state).toBe('running');
    expect(d.actions).toEqual([{ kind: 'spawnGate', gate: 2 }]);
  });

  test('gates advance 2 -> 3 -> 4', () => {
    expect(go('running', { kind: 'gateFinished', gate: 2, verdict: 'pass' }).actions)
      .toEqual([{ kind: 'spawnGate', gate: 3 }]);
    expect(go('running', { kind: 'gateFinished', gate: 3, verdict: 'pass' }).actions)
      .toEqual([{ kind: 'spawnGate', gate: 4 }]);
  });

  test('gate 4 passing opens the PR and waits on checks, not on review', () => {
    const d = go('running', { kind: 'gateFinished', gate: 4, verdict: 'pass' });
    expect(d.state).toBe('waitingChecks');
    expect(d.actions).toEqual([{ kind: 'reconcile' }]);
  });

  test('green checks request review rather than waiting for one', () => {
    const d = go('waitingChecks', { kind: 'checksGreen' });
    expect(d.state).toBe('reviewNotRequested');
    expect(d.actions).toEqual([{ kind: 'requestReview' }]);
  });

  test('approval releases the run', () => {
    const d = go('waitingReview', { kind: 'reviewApproved' });
    expect(d.state).toBe('approved');
    expect(d.actions).toEqual([{ kind: 'release' }]);
  });
});

describe('inconclusive is never a pass and never a failure', () => {
  test.each(gates)('an inconclusive gate %i stops the run and notifies', (gate) => {
    const d = go('running', { kind: 'gateFinished', gate, verdict: 'inconclusive' });
    expect(d.state).toBe('inconclusive');
    expect(d.actions.some((a) => a.kind === 'notify')).toBe(true);
    // The two ways of getting this wrong, asserted directly.
    expect(d.state).not.toBe('failed');
    expect(d.actions.some((a) => a.kind === 'spawnGate')).toBe(false);
  });

  test('an undriveable provision is inconclusive, not failed', () => {
    // Nothing ran, so there is no result for the change under test.
    const d = go('provisioning', { kind: 'provisionUndriveable' });
    expect(d.state).toBe('inconclusive');
  });

  test('a failed install IS a failure, and must stay distinguishable from the above', () => {
    const d = go('provisioning', { kind: 'provisionFailed' });
    expect(d.state).toBe('failed');
  });

  test('the budget running out is inconclusive: no verdict was reached', () => {
    expect(go('running', { kind: 'budgetExceeded' }).state).toBe('inconclusive');
  });

  test('only a person leaves inconclusive, and the run re-enters gate 2', () => {
    const d = go('inconclusive', { kind: 'humanApprovedGate' });
    expect(d.state).toBe('running');
    expect(d.actions).toEqual([{ kind: 'spawnGate', gate: 2 }]);
  });

  test('inconclusive ignores everything else, including a later pass', () => {
    // A gate reporting pass after the run already stopped is stale, not a
    // reason to resume: it was produced before whatever a person fixed.
    expect(go('inconclusive', { kind: 'gateFinished', gate: 3, verdict: 'pass' }).state)
      .toBe('inconclusive');
  });
});

describe('review', () => {
  test('a human change request returns to gate 2', () => {
    const d = go('waitingReview', {
      kind: 'reviewChangesRequested', verdict: { actor: 'human' },
    });
    expect(d.state).toBe('running');
    expect(d.actions).toEqual([{ kind: 'spawnGate', gate: 2 }]);
  });

  test('a bot nit is recorded and does NOT re-enter gate 2', () => {
    const d = go('waitingReview', {
      kind: 'reviewChangesRequested', verdict: { actor: 'bot', severity: 'nit' },
    });
    expect(d.state).toBe('waitingReview');
    expect(d.actions.some((a) => a.kind === 'spawnGate')).toBe(false);
    expect(d.actions.some((a) => a.kind === 'notify')).toBe(true);
  });

  test('a bot MAJOR finding does re-enter gate 2', () => {
    // CONTROL for the nit case: without this, treating every bot finding as a
    // nit would pass the test above and silently drop real findings.
    const d = go('waitingReview', {
      kind: 'reviewChangesRequested', verdict: { actor: 'bot', severity: 'major' },
    });
    expect(d.state).toBe('running');
    expect(d.actions).toEqual([{ kind: 'spawnGate', gate: 2 }]);
  });

  test('a bot finding with no severity is treated as a nit, not as major', () => {
    // Absent severity means the bot did not say. Escalating an unstated
    // severity burns owner cycles on notes; the finding is still surfaced.
    const d = go('waitingReview', {
      kind: 'reviewChangesRequested', verdict: { actor: 'bot' },
    });
    expect(d.state).toBe('waitingReview');
  });

  test('review is not requested until checks are green', () => {
    // Entering reviewNotRequested straight off gate 4 would ask an approver to
    // read a build that may still change, and would fire arbiter against it.
    expect(go('running', { kind: 'gateFinished', gate: 4, verdict: 'pass' }).state)
      .toBe('waitingChecks');
    expect(go('waitingChecks', { kind: 'reviewRequested' }).state)
      .toBe('waitingChecks');
  });

  test('red checks return to gate 2 rather than requesting review', () => {
    const d = go('waitingChecks', { kind: 'checksFailed' });
    expect(d.state).toBe('running');
    expect(d.actions).toEqual([{ kind: 'spawnGate', gate: 2 }]);
  });
});

describe('permission', () => {
  test('a prompt parks the run and answering resumes it', () => {
    const parked = go('running', { kind: 'permissionRequested' });
    expect(parked.state).toBe('waitingPermission');
    expect(go('waitingPermission', { kind: 'permissionAnswered' }).state).toBe('running');
  });

  test('an unanswered prompt never times out on its own', () => {
    // A silent auto-deny is indistinguishable from a gate finding, so the run
    // would carry a verdict nobody gave. Every other event leaves it parked.
    for (const event of ALL_EVENTS) {
      if (event.kind === 'permissionAnswered') continue;
      expect(go('waitingPermission', event).state).toBe('waitingPermission');
    }
  });
});

describe('approval is the end of attention, merge is not', () => {
  test('approved releases and does not wait for a merge', () => {
    expect(go('waitingReview', { kind: 'reviewApproved' }).actions)
      .toContainEqual({ kind: 'release' });
  });

  test('a merge afterwards is recorded but changes nothing about attention', () => {
    expect(go('approved', { kind: 'merged' }).state).toBe('done');
  });

  test('terminal states absorb every event', () => {
    for (const state of ['failed', 'done'] as RunState[]) {
      for (const event of ALL_EVENTS) {
        expect(go(state, event).state).toBe(state);
      }
    }
  });
});

describe('durability', () => {
  test('no (state, event) pairing throws', () => {
    // A run is resumable, so it WILL be handed stale and duplicate events: a
    // reconcile racing a webhook, a gate reporting twice after a restart.
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        expect(() => go(state, event)).not.toThrow();
      }
    }
  });

  test('an unhandled pairing stays put and says so, rather than advancing', () => {
    const d = go('waitingReview', { kind: 'prepared' });
    expect(d.state).toBe('waitingReview');
    expect(d.actions).toEqual([]);
    expect(d.note).toContain('ignored');
  });

  test('every decision carries a note, because run_events is the audit trail', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        expect(go(state, event).note.length).toBeGreaterThan(0);
      }
    }
  });

  test('a LATE report from an earlier gate does not regress the run', () => {
    // THE CASE THE SUITE WAS MISSING. Replaying the same event was covered;
    // an earlier gate reporting after a later one started was not. Without a
    // guard, a stale gate 2 pass arriving while gate 4 is in flight spawns
    // gate 3 again and throws away everything since.
    const d = transition(
      'running',
      { kind: 'gateFinished', gate: 2, verdict: 'pass' },
      { activeGate: 4 },
    );
    expect(d.state).toBe('running');
    expect(d.actions).toEqual([]);
    expect(d.note).toContain('gate 2 report');
  });

  test('a late report cannot end the run either', () => {
    // The same guard has to hold for the verdicts that STOP a run, or a stale
    // inconclusive from gate 2 parks a run whose gate 4 is doing fine.
    for (const verdict of ['fail', 'inconclusive'] as const) {
      const d = transition(
        'running',
        { kind: 'gateFinished', gate: 2, verdict },
        { activeGate: 4 },
      );
      expect({ verdict, state: d.state }).toEqual({ verdict, state: 'running' });
    }
  });

  test('a gate report with nothing in flight is ignored', () => {
    // It belongs to nothing this run started.
    const d = transition(
      'running',
      { kind: 'gateFinished', gate: 3, verdict: 'pass' },
      { activeGate: null },
    );
    expect(d.actions).toEqual([]);
  });

  test('the gate actually in flight is still acted on', () => {
    // CONTROL: without this, a guard that ignored everything would pass the
    // three cases above and stall every run.
    const d = transition(
      'running',
      { kind: 'gateFinished', gate: 4, verdict: 'pass' },
      { activeGate: 4 },
    );
    expect(d.state).toBe('waitingChecks');
  });

  test('checks going red before review is requested returns to gate 2', () => {
    // reviewNotRequested is meant to be transient, but a commit landing in
    // that window would otherwise park the run waiting for a review request
    // that should no longer be made.
    const d = go('reviewNotRequested', { kind: 'checksFailed' });
    expect(d.state).toBe('running');
    expect(d.actions).toEqual([{ kind: 'spawnGate', gate: 2 }]);
  });

  test('a duplicate gate result does not double-advance', () => {
    const first = go('running', { kind: 'gateFinished', gate: 2, verdict: 'pass' });
    expect(first.actions).toEqual([{ kind: 'spawnGate', gate: 3 }]);
    // Replaying the SAME event must propose the same thing, not gate 4.
    const replay = go('running', { kind: 'gateFinished', gate: 2, verdict: 'pass' });
    expect(replay).toEqual(first);
  });
});

describe('the state taxonomy the run inbox is built on', () => {
  test('the four states needing a person are exactly those listed', () => {
    expect([...NEEDS_A_PERSON].sort()).toEqual(
      ['inconclusive', 'waitingHumanGate', 'waitingPermission', 'waitingReview'],
    );
  });

  test('reviewNotRequested is NOT a wait — the engine acts there', () => {
    // Listing it beside the waits is how it stops being one: arbiter does not
    // fire until review is requested, so nothing is coming until we ask.
    expect(NEEDS_A_PERSON).not.toContain('reviewNotRequested');
    expect(go('waitingChecks', { kind: 'checksGreen' }).actions)
      .toEqual([{ kind: 'requestReview' }]);
  });

  test('working, waiting and terminal never overlap', () => {
    const overlapping = ALL_STATES.filter(
      (state) =>
        [IS_WORKING.includes(state), NEEDS_A_PERSON.includes(state), isTerminal(state)]
          .filter(Boolean).length > 1,
    );
    // Named rather than counted: a state in two buckets makes the run inbox
    // and the "is it working" indicator disagree about the same run.
    expect(overlapping).toEqual([]);
  });

  test('every state is accounted for by exactly one bucket or is a checkpoint', () => {
    const unclassified = ALL_STATES.filter(
      (s) => !IS_WORKING.includes(s) && !NEEDS_A_PERSON.includes(s) && !isTerminal(s),
    );
    // waitingChecks and reviewNotRequested are machine-driven checkpoints:
    // neither needs a person, and neither is terminal.
    expect(unclassified.sort()).toEqual(['reviewNotRequested', 'waitingChecks']);
  });
});
