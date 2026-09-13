/**
 * Driver tests (CO-722).
 *
 * A real database and the real state machine; only the commands are faked.
 * The properties under test are the ones a run's durability rests on, and
 * every one of them is about ORDER or about what is NOT written:
 *
 * - the transition lands before the action runs, so a crash mid-action leaves
 *   a record rather than a hole;
 * - an event that decides nothing writes nothing, so the log stays readable;
 * - the state comes from the database, not from the caller, because two
 *   things can advance a run and the stale one would overwrite the other;
 * - a cycle stops, loudly.
 *
 * Run with: bun test src/main/run-engine
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';

let db: Database;

mock.module('../../database', () => ({ getDatabase: () => db }));

const runs = await import('../../repositories/runs');
const { RUN_TABLES_SQL } = await import('../../run-tables-sql');
const { MAX_ROUNDS, advance } = await import('../driver');
const { execute } = await import('../executor');
import type { ExecutorDeps, ExecutorTarget } from '../executor';
import type { RunEvent } from '../transitions';

const TARGET: ExecutorTarget = {
  repo: 'Software-Development-LLC/Bodhilander',
  prNumber: 275,
  approvers: ['brannon-bowden'],
  initiativePath: 'C:/work/initiatives/CO-722',
  harnessPath: '/plugins/bodhi',
  pythonPath: 'C:/py/python.exe',
  agents: { 2: 'bsa-lead', 3: 'reviewer', 4: 'verifier' },
  posture: 'manual',
};

const OK = { code: 0, stdout: '', stderr: '' };

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    gh: async () => OK,
    plugin: async () => OK,
    spawnGate: async () => ({
      status: 'launched' as const,
      backgroundId: '11111111',
      sessionId: 'session',
      durationMs: 1,
    }),
    ...over,
  };
}

function seed(state = 'preparing'): string {
  runs.createRun({
    id: 'run-1',
    initiativeKey: 'CO-722',
    initiativeDir: 'C:/work/initiatives/CO-722',
    harnessPath: '/plugins/bodhi',
    bodhiRoot: 'C:/work/repos',
    pythonPath: 'C:/py/python.exe',
    permissionPosture: 'manual',
  });
  if (state !== 'preparing') {
    db.prepare('UPDATE runs SET state = ? WHERE id = ?').run(state, 'run-1');
  }
  return 'run-1';
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);');
  db.exec(RUN_TABLES_SQL);
});

describe('a state change and its reason land together', () => {
  test('the run moves as far as one call can take it', async () => {
    // Not to `provisioning` and no further: the provision succeeds, which
    // produces `provisioned`, which the same call applies. A driver that
    // stopped at the first transition would leave every run a step behind
    // until something else happened to look at it.
    const id = seed('preparing');
    const result = await advance(id, { kind: 'prepared' }, TARGET, deps());
    expect(result.applied.map((e) => e.kind)).toEqual(['prepared', 'provisioned']);
    expect(result.state).toBe('running');
    expect(runs.listEvents(id).map((e) => e.kind)).toEqual(['prepared', 'provisioned']);
  });

  test('the transition is written BEFORE the action runs', async () => {
    // The order the whole module is arranged around. An action that starts an
    // agent and then crashes must leave a record: "did that already happen?"
    // is otherwise a question somebody answers by looking at GitHub.
    const id = seed('provisioning');
    let stateWhenActionRan: string | undefined;
    await advance(id, { kind: 'provisioned' }, TARGET, deps({
      spawnGate: async () => {
        stateWhenActionRan = runs.getRun(id)?.state;
        return { status: 'launched', backgroundId: '1', sessionId: 's', durationMs: 1 };
      },
    }));
    expect(stateWhenActionRan).toBe('running');
  });

  test('a gate that crashes on launch still left a row behind', async () => {
    // The same rule as the transition, applied to gates: recorded BEFORE the
    // spawn, so a gate that starts and dies is a row somebody can see rather
    // than a run that says `running` with nothing to show for it. Ordering
    // the other way looks identical on every happy path, which is why this
    // asserts the crash.
    const id = seed('provisioning');
    await advance(id, { kind: 'provisioned' }, TARGET, deps({
      spawnGate: async () => {
        throw new Error('claude is not on PATH');
      },
    }));
    const gates = runs.listGates(id);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ gate: 2, agent: 'bsa-lead', status: 'running' });
  });

  test('a gate with no role recorded is not started at all', async () => {
    // run_gates.agent exists so somebody can tell afterwards who ran, and a
    // placeholder there is worse than an unspawned gate: it is an answer that
    // reads as one.
    const id = seed('provisioning');
    let spawned = false;
    const result = await advance(
      id,
      { kind: 'provisioned' },
      { ...TARGET, agents: {} },
      deps({ spawnGate: async () => { spawned = true; throw new Error('unreachable'); } }),
    );
    expect(runs.listGates(id)).toEqual([]);
    expect(result.problems[0]).toContain('no role recorded');
    // Not spawned, not merely unrecorded. A gate that runs with no row is
    // worse than one that does not run: it spends tokens, changes a worktree,
    // and leaves nothing saying it happened. The first version of this test
    // asserted `true` here, which is how the gap was found.
    expect(spawned).toBe(false);
  });

  test('a blocked run records why, not just that', async () => {
    // A run in the inbox saying it needs a person without saying what for
    // sends whoever opens it back to the log to work it out.
    const id = seed('waitingChecks');
    await advance(
      id,
      { kind: 'checksUndriveable', reason: 'no expected_checks recorded' },
      TARGET,
      deps(),
    );
    const run = runs.getRun(id);
    expect(run?.state).toBe('inconclusive');
    expect(run?.blockedReason).toBe('no expected_checks recorded');
  });
});

describe('what is not written', () => {
  test('an event that decides nothing leaves no trace', async () => {
    // The machine returns the state it is already in for an event that does
    // not apply. Recording those fills the log with rows saying nothing
    // happened — which is the log becoming unreadable, not complete.
    const id = seed('waitingReview');
    const before = runs.listEvents(id).length;
    const result = await advance(id, { kind: 'prepared' }, TARGET, deps());
    expect(result.applied).toEqual([]);
    expect(runs.listEvents(id)).toHaveLength(before);
    expect(runs.getRun(id)?.state).toBe('waitingReview');
  });

  test('a failed action records no event claiming it worked', async () => {
    // The executor reports rather than assumes, and this is where that pays:
    // the run stays in reviewNotRequested, which has its own retry cadence.
    const id = seed('waitingChecks');
    const result = await advance(id, { kind: 'checksGreen' }, TARGET, deps({
      gh: async () => ({ code: 1, stdout: '', stderr: 'HTTP 403' }),
    }));
    expect(runs.getRun(id)?.state).toBe('reviewNotRequested');
    expect(runs.listEvents(id).map((e) => e.kind)).not.toContain('reviewRequested');
    expect(result.problems[0]).toContain('HTTP 403');
  });
});

describe('the state comes from the database', () => {
  test('an event decides against what is stored, not what a caller remembers', async () => {
    // Two things advance a run — a reconcile pass and a gate finishing — and
    // a caller holding a state it read a minute ago would overwrite the
    // other's work from a stale position.
    const id = seed('waitingChecks');
    db.prepare('UPDATE runs SET state = ? WHERE id = ?').run('waitingReview', id);
    const result = await advance(id, { kind: 'reviewApproved' }, TARGET, deps());
    expect(result.state).toBe('approved');
  });

  test('a run that is not there is a problem, not a crash', async () => {
    const result = await advance('nonesuch', { kind: 'prepared' }, TARGET, deps());
    expect(result.problems[0]).toContain('not in the database');
  });

  test('a stale gate report cannot regress the run', async () => {
    // The activeGate guard, driven through the driver: the gate the run is
    // INSIDE comes from run_gates, so a late gate-2 verdict arriving after
    // gate 4 is ignored rather than pulling the run backwards.
    const id = seed('running');
    runs.startGate({ id: 'g4', runId: id, gate: 4, agent: 'verifier', posture: 'manual' });
    const result = await advance(
      id,
      { kind: 'gateFinished', gate: 2, verdict: 'pass' },
      TARGET,
      deps(),
    );
    expect(result.applied).toEqual([]);
    expect(runs.getRun(id)?.state).toBe('running');
  });

  test('and the gate that IS active advances it', async () => {
    // CONTROL: a guard that ignored every report would satisfy the case above
    // and freeze every run at its first gate.
    const id = seed('running');
    runs.startGate({ id: 'g2', runId: id, gate: 2, agent: 'bsa-lead', posture: 'manual' });
    const result = await advance(
      id,
      { kind: 'gateFinished', gate: 2, verdict: 'pass' },
      TARGET,
      deps(),
    );
    expect(result.applied).toHaveLength(1);
    // Still `running`, and that is the point: gate 2 passing does not move
    // the run, it moves the GATE. The row for 2 is closed with its verdict
    // and a row for 3 is open — which is progress the state alone cannot show.
    const gates = runs.listGates(id);
    expect(gates.find((g) => g.gate === 2)?.status).toBe('done');
    expect(gates.find((g) => g.gate === 3)?.status).toBe('running');
    expect(runs.activeGate(id)?.gate).toBe(3);
  });
});

describe('the loop', () => {
  test('an action’s event is applied in the same call', async () => {
    // provisioned → spawnGate, and a gate that comes back undriveable
    // produces gateFinished, which the same call must apply. Otherwise a run
    // sits in `running` until something else happens to look at it.
    const id = seed('provisioning');
    const result = await advance(id, { kind: 'provisioned' }, TARGET, deps({
      spawnGate: async () => ({
        status: 'undriveable',
        reason: 'claude is not on PATH',
        detail: null,
        durationMs: 1,
      }),
    }));
    expect(result.applied.map((e) => e.kind)).toEqual(['provisioned', 'gateFinished']);
    expect(runs.getRun(id)?.state).toBe('inconclusive');
  });

  test('a cycle stops, and says it is a fault', async () => {
    // The machine has cycles by design — gate 3 sends a run back to gate 2.
    // One that does not settle would spin for as long as the process lives,
    // so the limit is a tripwire rather than a tuning knob.
    const id = seed('running');
    runs.startGate({ id: 'g3', runId: id, gate: 3, agent: 'reviewer', posture: 'manual' });
    const result = await advance(id, { kind: 'gateFinished', gate: 3, verdict: 'fail' }, TARGET, {
      ...deps(),
      // Every spawn reports a failed gate 2, which sends the run back to
      // gate 2, which spawns again.
      spawnGate: async () => {
        const gate = runs.activeGate(id);
        if (gate) runs.finishGate(gate.id, 'done');
        runs.startGate({
          id: `g${Math.random()}`, runId: id, gate: 2, agent: 'owner', posture: 'manual',
        });
        return {
          status: 'completed' as const,
          structuredOutput: { verdict: 'fail', summary: 'still broken' },
          sessionId: null,
          costUsd: null,
          durationMs: 1,
        };
      },
    });
    expect(result.runaway).toContain('cycle');
    expect(result.problems).toContain(result.runaway);
  });

  test('the limit is not reached by an ordinary advance', async () => {
    // CONTROL for the tripwire: if a normal run tripped it, the number would
    // be a tuning knob and every real advance would report a fault.
    const id = seed('preparing');
    const result = await advance(id, { kind: 'prepared' }, TARGET, deps());
    expect(result.runaway).toBeNull();
    expect(MAX_ROUNDS).toBeGreaterThan(2);
  });
});

describe('the round limit', () => {
  test('a run that settles on the last permitted round is not a cycle', async () => {
    // The loop exits by falling off the `for` condition here, not by the
    // early return at the top — so an unconditional "runaway" puts a fault on
    // a run that finished correctly and merely took the long way.
    //
    // The fake touches no rows: openGates opens gate 2 each round and the
    // driver closes it when the report is accepted, so a failing gate 2
    // cycles on its own. An earlier version juggled run_gates itself and
    // broke the chain at round one, which is why it passed against the bug.
    const id = seed('running');
    runs.startGate({ id: 'g2', runId: id, gate: 2, agent: 'bsa-lead', posture: 'manual' });
    let spawns = 0;
    const result = await advance(id, { kind: 'gateFinished', gate: 2, verdict: 'fail' }, TARGET, {
      ...deps(),
      spawnGate: async () => {
        spawns += 1;
        // MAX_ROUNDS, not one less: settling a round early means the loop
        // returns from the check at the TOP and never reaches the boundary
        // this test exists for. Off by one here and it passes against the bug.
        if (spawns >= MAX_ROUNDS) {
          // Settles: a launch reports no event, so this round produces none.
          return { status: 'launched' as const, backgroundId: '1', sessionId: 's', durationMs: 1 };
        }
        return {
          status: 'completed' as const,
          structuredOutput: { verdict: 'fail', summary: 'again' },
          sessionId: null,
          costUsd: null,
          durationMs: 1,
        };
      },
    });
    expect(spawns).toBe(MAX_ROUNDS);
    expect(result.runaway).toBeNull();
  });
});

describe('one run advances at a time', () => {
  test('a second call waits for the first to finish', async () => {
    // What the queue actually guarantees, asserted as what can be observed.
    //
    // Not a timing-overlap test: reading, deciding and writing are
    // synchronous inside one round, so a single advance is already atomic and
    // an overlap assertion passes with no queue at all — which is what two
    // earlier versions of this test did. What the queue adds is that a
    // MULTI-ROUND advance is atomic too, and the visible consequence is that
    // the second call does not begin until the first has returned.
    const id = seed('provisioning');
    const order: string[] = [];
    const label = (name: string) =>
      deps({
        spawnGate: async () => {
          order.push(`${name}:start`);
          await new Promise((resolve) => { setTimeout(resolve, 10); });
          order.push(`${name}:end`);
          return { status: 'launched' as const, backgroundId: '1', sessionId: 's', durationMs: 1 };
        },
      });
    await Promise.all([
      advance(id, { kind: 'provisioned' }, TARGET, label('first')),
      advance(id, { kind: 'gateFinished', gate: 2, verdict: 'fail' }, TARGET, label('second')),
    ]);
    // Interleaved, this reads first:start, second:start, ... Serialised, the
    // first pair closes before the second opens.
    expect(order.slice(0, 2)).toEqual(['first:start', 'first:end']);
  });

  test('a different run is not held up behind it', async () => {
    // CONTROL: a single global lock would serialise every run in the app
    // behind whichever one is slowest, which is a worse problem than the one
    // being solved.
    seed('preparing');
    runs.createRun({
      id: 'run-2',
      initiativeKey: 'CO-723',
      initiativeDir: 'C:/work/initiatives/CO-723',
      harnessPath: '/plugins/bodhi',
      bodhiRoot: 'C:/work/repos',
      permissionPosture: 'manual',
    });
    const order: string[] = [];
    const first = advance('run-1', { kind: 'prepared' }, TARGET, deps({
      plugin: async () => {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        order.push('run-1');
        return OK;
      },
    }));
    const second = advance('run-2', { kind: 'prepared' }, TARGET, deps({
      plugin: async () => {
        order.push('run-2');
        return OK;
      },
    }));
    await Promise.all([first, second]);
    expect(order).toEqual(['run-2', 'run-1']);
  });

  test('a failure does not wedge the queue behind it', async () => {
    const id = seed('preparing');
    await advance(id, { kind: 'prepared' }, TARGET, deps({
      plugin: async () => { throw new Error('boom'); },
    }));
    const after = await advance(id, { kind: 'provisioned' }, TARGET, deps());
    expect(after.problems.filter((p) => p.includes('boom'))).toEqual([]);
  });
});

describe('what the caller is told', () => {
  test('notifications and problems come back together with the state', async () => {
    const id = seed('provisioning');
    const result = await advance(id, { kind: 'provisioned' }, TARGET, deps({
      spawnGate: async () => ({
        status: 'undriveable',
        reason: 'claude is not on PATH',
        detail: null,
        durationMs: 1,
      }),
    }));
    expect(result.notifications).toContain('claude is not on PATH');
    expect(result.state).toBe('inconclusive');
  });

  test('a released run says so', async () => {
    const id = seed('waitingReview');
    const result = await advance(id, { kind: 'reviewApproved' }, TARGET, deps());
    expect(result.released).toBe(true);
    expect(result.state).toBe('approved');
  });
});

describe('the executor is reached with the decision’s own actions', () => {
  test('nothing is invented between deciding and doing', async () => {
    // Bound to execute() itself rather than a stub, because an action shape
    // the driver builds by hand would drift from what the machine emits.
    const performed: string[] = [];
    const id = seed('waitingChecks');
    await advance(id, { kind: 'checksGreen' }, TARGET, deps({
      gh: async (argv) => {
        performed.push(argv.join(' '));
        return OK;
      },
    }));
    expect(performed[0]).toContain('--add-reviewer brannon-bowden');
    expect(typeof execute).toBe('function');
  });
});
