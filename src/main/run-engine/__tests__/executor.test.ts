/**
 * Executor tests (CO-722).
 *
 * This is the first module in the engine that changes anything outside the
 * process — it asks GitHub to notify a person, and it installs into a
 * worktree. So the tests are mostly about restraint: what it does NOT do when
 * something goes wrong, and what it refuses to claim.
 *
 * The rule under test throughout: an action that failed is not a run that
 * failed. `gh` refusing to add a reviewer says nothing about the branch, so
 * the run stays put and the next attention pass tries again. The opposite —
 * recording `reviewRequested` because the call was made rather than because
 * it worked — leaves a run waiting on a person nobody asked.
 *
 * Run with: bun test src/main/run-engine
 */
import { describe, expect, test } from 'bun:test';
import { execute, gateEvent, provisionEvent, type ExecutorDeps, type ExecutorTarget } from '../executor';
import { transition } from '../transitions';
import type { GateOutcome } from '../gate-process';

const TARGET: ExecutorTarget = {
  repo: 'Software-Development-LLC/Bodhilander',
  prNumber: 273,
  approvers: ['brannon-bowden', 'William-Long-II'],
  initiativePath: 'C:/work/initiatives/CO-722',
  harnessPath: '/plugins/bodhi',
  pythonPath: 'C:/py/python.exe',
  agents: { 2: ['bsa-lead'], 3: ['reviewer'], 4: ['verifier', 'scribe'] },
  posture: 'manual',
};

const OK = { code: 0, stdout: '', stderr: '' };

interface FakeOptions {
  gh?: { code: number; stdout: string; stderr: string };
  plugin?: { code: number; stdout: string; stderr: string };
  provision?: { code: number; stdout: string; stderr: string };
  gate?: GateOutcome;
}

function fake(options: FakeOptions = {}) {
  const calls: { kind: string; argv?: string[] }[] = [];
  const deps: ExecutorDeps = {
    gh: async (argv) => {
      calls.push({ kind: 'gh', argv: [...argv] });
      return options.gh ?? OK;
    },
    plugin: async (argv) => {
      calls.push({ kind: 'plugin', argv: [...argv] });
      return options.plugin ?? OK;
    },
    // Recorded under its OWN name, not folded in with `plugin`. The two are
    // separate dependencies because they are spawned on different clocks, and
    // a test that could not tell which one ran would not notice provisioning
    // being put back on the one-minute deadline that killed a real install.
    provision: async () => {
      calls.push({ kind: 'provision', argv: [] });
      return options.provision ?? OK;
    },
    spawnGate: async (gate, agent) => {
      calls.push({ kind: `spawnGate:${gate}`, argv: [agent] });
      return (
        options.gate ?? { status: 'launched', backgroundId: '11111111', sessionId: 'x', durationMs: 1 }
      );
    },
  };
  return { deps, calls };
}

describe('requesting a review', () => {
  test('asks the recorded approvers, and says so only once it worked', async () => {
    const { deps, calls } = fake();
    const result = await execute([{ kind: 'requestReview' }], TARGET, deps);
    expect(calls[0].argv).toEqual([
      'pr', 'edit', '273',
      '--repo', 'Software-Development-LLC/Bodhilander',
      '--add-reviewer', 'brannon-bowden,William-Long-II',
    ]);
    expect(result.events).toEqual([{ kind: 'reviewRequested' }]);
  });

  test('a failed request leaves the run where it is', async () => {
    // THE rule. Recording reviewRequested because the call was made rather
    // than because it worked leaves a run waiting on a person nobody asked —
    // and waitingReview is polled every five minutes, so it would wait a long
    // time before anybody wondered.
    const { deps } = fake({ gh: { code: 1, stdout: '', stderr: 'HTTP 403' } });
    const result = await execute([{ kind: 'requestReview' }], TARGET, deps);
    expect(result.events).toEqual([]);
    expect(result.problems[0]).toContain('HTTP 403');
  });

  test('and the run is re-attempted rather than stranded', async () => {
    // The other half of that rule, bound to the real machine: the state it
    // stays in has an action-retry cadence, so a failed request comes back.
    const decision = transition('waitingChecks', { kind: 'checksGreen' }, { activeGate: null });
    expect(decision.state).toBe('reviewNotRequested');
    expect(decision.actions).toEqual([{ kind: 'requestReview' }]);
  });

  test('nobody to ask is a problem, not a silence', async () => {
    // The run would otherwise sit re-attempting an empty request forever.
    const { deps, calls } = fake();
    const result = await execute([{ kind: 'requestReview' }], { ...TARGET, approvers: [] }, deps);
    expect(calls).toEqual([]);
    expect(result.problems[0]).toContain('nobody can be asked');
  });

  test('no PR yet is a problem, not a request to nowhere', async () => {
    const { deps, calls } = fake();
    const result = await execute([{ kind: 'requestReview' }], { ...TARGET, prNumber: null }, deps);
    expect(calls).toEqual([]);
    expect(result.problems[0]).toContain('before a PR exists');
  });
});

describe('provisioning', () => {
  test('the plugin’s exit codes keep their meanings', () => {
    // Unchanged from docs/EXIT-CODES.md: 0 installed, 1 an install ran and
    // failed, 2 nothing could be run, 3 nothing was owed.
    expect(provisionEvent(0)).toEqual({ kind: 'provisioned' });
    expect(provisionEvent(1)).toEqual({ kind: 'provisionFailed', reason: undefined });
    expect(provisionEvent(2)).toEqual({ kind: 'provisionUndriveable' });
  });

  test('a failed provision carries the install output as its reason', () => {
    // So the run's blocked_reason says WHAT broke (the first failing line),
    // not just that something did.
    expect(provisionEvent(1, 'bodhi-service-api: yarn install failed: ELIFECYCLE'))
      .toEqual({ kind: 'provisionFailed', reason: 'bodhi-service-api: yarn install failed: ELIFECYCLE' });
  });

  test('nothing owed is a provisioned run, not a fault', () => {
    // A repo recording neither pkg nor lang has nothing to install. Stopping
    // for it would block every Go and dotnet repo on a step that does not
    // apply to them.
    expect(provisionEvent(3)).toEqual({ kind: 'provisioned' });
  });

  test('an unrecognised code is undriveable, never provisioned', () => {
    // 127 and 124 arrive here from the command runner. Neither is evidence
    // that anything was installed.
    for (const code of [127, 124, 9]) {
      expect(provisionEvent(code)).toEqual({ kind: 'provisionUndriveable' });
    }
  });

  test('a failure carries the plugin’s own words to a person', async () => {
    // A code says what happened; the plugin's output says what to do.
    const { deps } = fake({
      provision: { code: 2, stdout: 'yarn is not on PATH', stderr: '' },
    });
    const result = await execute([{ kind: 'provision' }], TARGET, deps);
    expect(result.events).toEqual([{ kind: 'provisionUndriveable' }]);
    expect(result.notifications[0]).toBe('yarn is not on PATH');
  });

  test('a clean install says nothing to anybody', async () => {
    const { deps } = fake();
    const result = await execute([{ kind: 'provision' }], TARGET, deps);
    expect(result.events).toEqual([{ kind: 'provisioned' }]);
    expect(result.notifications).toEqual([]);
  });
});

describe('spawning a gate', () => {
  test('a background launch reports nothing, because nothing happened yet', async () => {
    // Its verdict arrives later in a receipt. An event here would be a
    // verdict recorded before the gate did the work.
    const { deps } = fake();
    const result = await execute([{ kind: 'spawnGate', gate: 2, agent: 'bsa-lead' }], TARGET, deps);
    expect(result.events).toEqual([]);
  });

  test('a gate that established nothing is inconclusive, never a failure', async () => {
    const { deps } = fake({
      gate: { status: 'undriveable', reason: 'the gate did not finish', detail: null, durationMs: 1 },
    });
    const result = await execute([{ kind: 'spawnGate', gate: 3, agent: 'reviewer' }], TARGET, deps);
    expect(result.events).toEqual([{ kind: 'gateFinished', gate: 3, verdict: 'inconclusive' }]);
    expect(result.notifications[0]).toContain('did not finish');
  });

  test('a completed gate reports the verdict it actually returned', () => {
    const completed = (structuredOutput: unknown): GateOutcome => ({
      status: 'completed',
      structuredOutput,
      sessionId: null,
      costUsd: null,
      durationMs: 1,
    });
    expect(gateEvent(3, completed({ verdict: 'pass', summary: 'fine' }))).toEqual({
      kind: 'gateFinished', gate: 3, verdict: 'pass',
    });
    expect(gateEvent(3, completed({ verdict: 'fail', summary: 'no' }))).toEqual({
      kind: 'gateFinished', gate: 3, verdict: 'fail',
    });
  });

  test('a verdict that cannot be read is inconclusive, never a pass', () => {
    // The one sentence the whole verdict module exists for, asserted at the
    // seam where it reaches the state machine.
    for (const output of [null, {}, { verdict: 'approved' }, 'pass']) {
      expect(gateEvent(3, {
        status: 'completed', structuredOutput: output, sessionId: null, costUsd: null, durationMs: 1,
      })).toEqual({ kind: 'gateFinished', gate: 3, verdict: 'inconclusive' });
    }
  });
});

describe('the actions that are not calls', () => {
  test('notify collects reasons in order', async () => {
    const { deps } = fake();
    const result = await execute(
      [{ kind: 'notify', reason: 'first' }, { kind: 'notify', reason: 'second' }],
      TARGET,
      deps,
    );
    expect(result.notifications).toEqual(['first', 'second']);
  });

  test('release is said, not done', async () => {
    // Attending is something the caller stops doing. There is nothing to call.
    const { deps, calls } = fake();
    const result = await execute([{ kind: 'release' }], TARGET, deps);
    expect(result.released).toBe(true);
    expect(calls).toEqual([]);
  });

  test('reconcile runs nothing here', async () => {
    // The loop owns when to ask. A pass here would ask twice for one decision
    // and race the pass already scheduled.
    const { deps, calls } = fake();
    const result = await execute([{ kind: 'reconcile' }], TARGET, deps);
    expect(calls).toEqual([]);
    expect(result.events).toEqual([]);
  });

  test('a run not released stays unreleased', async () => {
    // CONTROL: a flag that defaulted true would stop the engine attending to
    // every run after its first decision.
    const { deps } = fake();
    expect((await execute([{ kind: 'notify', reason: 'x' }], TARGET, deps)).released).toBe(false);
  });
});

describe('who a spawn runs as', () => {
  test('the role on the action is the role that is launched', async () => {
    // The machine says `spawnGate 4`; the driver says WHICH of gate 4's roles.
    // This module must pass that through rather than reach into
    // `target.agents` and pick, or the sequencing decision lives in two
    // places and the second one wins silently.
    const { deps, calls } = fake();
    await execute([{ kind: 'spawnGate', gate: 4, agent: 'scribe' }], TARGET, deps);
    expect(calls).toEqual([{ kind: 'spawnGate:4', argv: ['scribe'] }]);
  });
});

describe('order', () => {
  test('actions run in the order the decision gave them', async () => {
    // A decision that provisions and then spawns means the install happens
    // first. Running them concurrently starts an owner in a worktree with no
    // dependencies — the exact failure verify.sh now reports as undriveable.
    const { deps, calls } = fake();
    await execute([{ kind: 'provision' }, { kind: 'spawnGate', gate: 2, agent: 'bsa-lead' }], TARGET, deps);
    expect(calls.map((c) => c.kind)).toEqual(['provision', 'spawnGate:2']);
  });

  test('a failed install does not launch a gate into the worktree', async () => {
    // Ordering alone does not deliver "the install happens first" -- it has
    // to STOP. An install that failed and a gate launched anyway is an owner
    // started in a worktree with no dependencies, which is the exact failure
    // verify.sh now reports as undriveable, arrived at by the engine rather
    // than by a person.
    const { deps, calls } = fake({ provision: { code: 1, stdout: 'yarn install failed', stderr: '' } });
    const result = await execute(
      [{ kind: 'provision' }, { kind: 'spawnGate', gate: 2, agent: 'bsa-lead' }],
      TARGET,
      deps,
    );
    expect(calls.map((c) => c.kind)).toEqual(['provision']);
    expect(result.events).toEqual([{ kind: 'provisionFailed' }]);
    expect(result.problems[0]).toContain('spawnGate was not performed');
  });

  test('an undriveable install stops the decision too', async () => {
    const { deps, calls } = fake({ provision: { code: 2, stdout: 'yarn is not on PATH', stderr: '' } });
    await execute([{ kind: 'provision' }, { kind: 'spawnGate', gate: 2, agent: 'bsa-lead' }], TARGET, deps);
    expect(calls.map((c) => c.kind)).toEqual(['provision']);
  });

  test('a guard that refused before calling anything stops it as well', async () => {
    // The initiativePath guard returns without running provision at all, and
    // an early return that did not halt would be the quietest version of this
    // bug -- no failure event to notice, and a gate launched regardless.
    const { deps, calls } = fake();
    await execute(
      [{ kind: 'provision' }, { kind: 'spawnGate', gate: 2, agent: 'bsa-lead' }],
      { ...TARGET, initiativePath: null },
      deps,
    );
    expect(calls).toEqual([]);
  });

  test('a person is still told after a halt', async () => {
    // notify changes nothing outside the process; it is how somebody finds
    // out. Suppressing it would make the halt the quietest thing in the run.
    const { deps } = fake({ provision: { code: 1, stdout: 'install failed', stderr: '' } });
    const result = await execute(
      [{ kind: 'provision' }, { kind: 'notify', reason: 'gate 2 is blocked' }],
      TARGET,
      deps,
    );
    expect(result.notifications).toContain('gate 2 is blocked');
  });

  test('a halted run is not released', async () => {
    // Releasing a run whose actions failed stops the engine attending to the
    // one run that most needs attending to.
    const { deps } = fake({ gh: { code: 1, stdout: '', stderr: 'HTTP 403' } });
    const result = await execute(
      [{ kind: 'requestReview' }, { kind: 'release' }],
      TARGET,
      deps,
    );
    expect(result.released).toBe(false);
  });

  test('a dependency that throws does not lose what was already collected', async () => {
    // runGate throws synchronously for a call it cannot make at all -- no
    // executable, an argv past the Windows ceiling. Letting that escape would
    // discard the events explaining how the run got here.
    const { deps } = fake();
    deps.spawnGate = async () => {
      throw new Error('gate command is 31000 characters of argv');
    };
    const result = await execute(
      [{ kind: 'provision' }, { kind: 'spawnGate', gate: 2, agent: 'bsa-lead' }],
      TARGET,
      deps,
    );
    expect(result.events).toEqual([{ kind: 'provisioned' }]);
    expect(result.problems[0]).toContain('31000 characters');
  });

  test('everything still runs when nothing fails', async () => {
    // CONTROL: halting on success would stop every decision after its first
    // action, which is a quieter failure than the one being fixed.
    const { deps, calls } = fake();
    const result = await execute(
      [{ kind: 'provision' }, { kind: 'spawnGate', gate: 2, agent: 'bsa-lead' }, { kind: 'notify', reason: 'x' }],
      TARGET,
      deps,
    );
    expect(calls.map((c) => c.kind)).toEqual(['provision', 'spawnGate:2']);
    expect(result.problems).toEqual([]);
  });

  test('a decision from the real machine is performed end to end', async () => {
    // Bound to transitions rather than a hand-written action list, because an
    // action shape that drifts from what the machine emits is a switch arm
    // that silently never runs.
    const decision = transition('provisioning', { kind: 'provisioned' }, { activeGate: null });
    const { deps, calls } = fake();
    await execute(decision.actions, TARGET, deps);
    expect(calls.map((c) => c.kind)).toEqual(['spawnGate:2']);
  });
});
