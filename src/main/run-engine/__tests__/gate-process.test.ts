/**
 * Gate process tests (CO-722).
 *
 * Real child processes, not mocks. What this module does IS spawn, read and
 * classify, so a mocked `spawn` would assert my own beliefs about how a
 * process behaves — and every bug worth catching here lives in exactly that
 * gap. `process.execPath` stands in for `claude`: a real executable, given a
 * real argv, producing real stdout on a real `close`.
 *
 * The classification is the point. Two of the three outcomes look like
 * success from the outside — exit 0, no stderr — and the one thing that must
 * never happen is either of them being read as a verdict.
 *
 * Run with: bun test src/main/run-engine
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { runGate, backgroundIdFor, GateSpawnError, type GateOutcome } from '../gate-process';
import type { GateCommand } from '../gate-command';

const SESSION = '11111111-2222-3333-4444-555555555555';

/**
 * A command whose "CLI" is node printing `emit`.
 *
 * The flags the module reads — `--json-schema`, `--bg`, `--session-id` — are
 * carried in argv exactly where a real gate carries them, because the module
 * reads the mode back OUT of the command rather than being told it twice.
 */
function printGate(emit: string, extra: string[] = []): GateCommand {
  return {
    argv: ['-e', `process.stdout.write(${JSON.stringify(emit)})`, '--json-schema', '{}',
      '--session-id', SESSION, ...extra],
    stdin: 'review the diff',
    cwd: process.cwd(),
    env: { BODHI_ROOT: '/root' },
  };
}

function backgroundGate(script: string, argv: string[] = ['--session-id', SESSION]): GateCommand {
  return {
    argv: ['-e', script, '--bg', ...argv],
    stdin: null,
    cwd: process.cwd(),
    env: { BODHI_ROOT: '/root' },
  };
}

const OPTIONS = { executable: process.execPath, timeoutMs: 20_000 };

function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    terminal_reason: 'completed',
    session_id: SESSION,
    total_cost_usd: 0.43,
    result: 'done',
    ...over,
  });
}

async function run(command: GateCommand, over: Partial<typeof OPTIONS> = {}): Promise<GateOutcome> {
  return runGate(command, { ...OPTIONS, ...over });
}

describe('a print gate that answered', () => {
  test('returns the structured output and what it cost', async () => {
    const outcome = await run(printGate(envelope({ structured_output: { verdict: 'pass' } })));
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    expect(outcome.structuredOutput).toEqual({ verdict: 'pass' });
    expect(outcome.sessionId).toBe(SESSION);
    expect(outcome.costUsd).toBe(0.43);
  });

  test('a fail verdict is still a completed gate', async () => {
    // The module reports what the gate ESTABLISHED, not whether the branch is
    // good. Reading "changes_requested" as a broken gate would put every
    // honest rejection in the same bucket as a crash.
    const outcome = await run(
      printGate(envelope({ structured_output: { verdict: 'changes_requested' } })),
    );
    expect(outcome.status).toBe('completed');
  });
});

describe('a print gate that established nothing', () => {
  test('success with no structured_output is undriveable, not a pass', async () => {
    // Measured: --agent and --json-schema together return subtype success,
    // is_error false, exit 0 and no structured output at all.
    const outcome = await run(printGate(envelope()));
    expect(outcome.status).toBe('undriveable');
    if (outcome.status !== 'undriveable') throw new Error('unreachable');
    expect(outcome.reason).toContain('no structured_output');
  });

  test('prose that happens to parse as JSON is never promoted to a verdict', async () => {
    // The tempting fallback: read `result` when structured_output is missing.
    // This asserts it does not happen — the text here is a complete, valid
    // verdict object, and it must still be undriveable.
    const outcome = await run(printGate(envelope({ result: '{"verdict":"pass"}' })));
    expect(outcome.status).toBe('undriveable');
  });

  test('a non-JSON stream is undriveable and keeps what it saw', async () => {
    const outcome = await run(printGate('Sure! Here is my review of the diff.'));
    expect(outcome.status).toBe('undriveable');
    if (outcome.status !== 'undriveable') throw new Error('unreachable');
    expect(outcome.reason).toContain('not the JSON result envelope');
    expect(outcome.detail).toContain('Here is my review');
  });

  test('is_error outranks a subtype of success', async () => {
    const outcome = await run(printGate(envelope({ is_error: true })));
    expect(outcome.status).toBe('undriveable');
  });

  test('an error subtype is undriveable even carrying structured output', async () => {
    const outcome = await run(
      printGate(envelope({ subtype: 'error_max_turns', structured_output: { verdict: 'pass' } })),
    );
    expect(outcome.status).toBe('undriveable');
    if (outcome.status !== 'undriveable') throw new Error('unreachable');
    expect(outcome.reason).toContain('error_max_turns');
  });

  test('a failure with nothing to show reports null, not an empty string', async () => {
    // `.trim()` returns '' rather than null, so `??` chains past neither --
    // the detail arrives as an empty string against a `string | null`
    // contract, and a caller rendering "detail if present" shows a blank row.
    const outcome = await run(printGate(envelope({ subtype: 'error_during_execution', result: '' })));
    if (outcome.status !== 'undriveable') throw new Error(`expected undriveable, got ${outcome.status}`);
    expect(outcome.detail).toBeNull();
  });

  test('an interrupted terminal_reason is undriveable', async () => {
    const outcome = await run(
      printGate(envelope({ terminal_reason: 'interrupted', structured_output: { verdict: 'pass' } })),
    );
    expect(outcome.status).toBe('undriveable');
  });
});

describe('stop_reason is never read', () => {
  test("a successful run reporting stop_reason 'tool_use' still completes", async () => {
    // THE trap, and it is not hypothetical: a fully successful run reports
    // stop_reason "tool_use". A module that checked it would report every
    // green gate as broken, and the run would loop on working code.
    const outcome = await run(
      printGate(envelope({ stop_reason: 'tool_use', structured_output: { verdict: 'pass' } })),
    );
    expect(outcome.status).toBe('completed');
  });

  test("a failing run claiming stop_reason 'end_turn' is still undriveable", async () => {
    // The control. If stop_reason were read, this would pass on a run that
    // reported an error — the same mistake in the opposite direction.
    const outcome = await run(
      printGate(envelope({ stop_reason: 'end_turn', is_error: true })),
    );
    expect(outcome.status).toBe('undriveable');
  });
});

describe('a background gate', () => {
  test('launching is a launch, not an answer', async () => {
    const outcome = await run(backgroundGate('process.stdout.write("started")'));
    expect(outcome.status).toBe('launched');
    if (outcome.status !== 'launched') throw new Error('unreachable');
    expect(outcome.sessionId).toBe(SESSION);
    expect(outcome.backgroundId).toBe('11111111');
  });

  test('the attach id is the first 8 characters of the session id', () => {
    expect(backgroundIdFor(SESSION)).toBe('11111111');
    expect(backgroundIdFor(SESSION).length).toBe(8);
  });

  test('a non-zero exit is undriveable and keeps stderr', async () => {
    const outcome = await run(
      backgroundGate('process.stderr.write("no such agent"); process.exit(1)'),
    );
    expect(outcome.status).toBe('undriveable');
    if (outcome.status !== 'undriveable') throw new Error('unreachable');
    expect(outcome.detail).toContain('no such agent');
  });

  test('launching with no session id is undriveable, not running', async () => {
    // Nothing could attach to, reconcile or resume this gate. Recording it as
    // running would create a session the engine can never speak to again —
    // which is worse than not starting it, because a person sees a live row.
    const outcome = await run(backgroundGate('process.stdout.write("started")', []));
    expect(outcome.status).toBe('undriveable');
    if (outcome.status !== 'undriveable') throw new Error('unreachable');
    expect(outcome.reason).toContain('attach');
  });

  test('a background gate is never asked for structured output', async () => {
    // --bg and --print conflict outright, so a background command carries no
    // schema. Applying the print rules to it would make every launch
    // undriveable for lacking a verdict it was never asked for.
    const outcome = await run(backgroundGate('process.stdout.write("")'));
    expect(outcome.status).toBe('launched');
  });
});

describe('a gate that never finished', () => {
  test('a timeout is undriveable, never a failure', async () => {
    // "Ask what nobody knows": something ran, so it feels like a result, but
    // it ran to no conclusion. Reporting a failure here sends an owner back
    // to fix code that may be fine.
    const outcome = await run(backgroundGate('setTimeout(() => {}, 60000)'), {
      timeoutMs: 300,
    });
    expect(outcome.status).toBe('undriveable');
    if (outcome.status !== 'undriveable') throw new Error('unreachable');
    expect(outcome.reason).toContain('did not finish');
  });

  test('a cancel is undriveable and says so', async () => {
    const controller = new AbortController();
    const pending = runGate(backgroundGate('setTimeout(() => {}, 60000)'), {
      ...OPTIONS,
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await pending;
    expect(outcome.status).toBe('undriveable');
    if (outcome.status !== 'undriveable') throw new Error('unreachable');
    expect(outcome.reason).toContain('cancelled');
  });

  test('an executable that does not exist is undriveable, not a throw', async () => {
    // A missing CLI is a run outcome a person has to see, not an exception
    // that unwinds whatever was driving the run.
    const outcome = await run(printGate(envelope()), {
      executable: `${process.execPath}.definitely-not-here`,
    });
    expect(outcome.status).toBe('undriveable');
    if (outcome.status !== 'undriveable') throw new Error('unreachable');
    expect(outcome.reason).toContain('could not be started');
  });
});

describe('calls that are unusable', () => {
  test('a bare command name is refused rather than shelled out', () => {
    expect(() => runGate(printGate(envelope()), { ...OPTIONS, executable: '' })).toThrow(
      GateSpawnError,
    );
  });

  test('an argv over the Windows ceiling is refused before spawning', () => {
    // ENAMETOOLONG arrives before the process starts, and the fix is always
    // to pass the large value as a file. Failing here names it; failing in
    // uv_spawn does not.
    const huge = printGate(envelope());
    huge.argv.push('x'.repeat(31_000));
    expect(() => runGate(huge, OPTIONS)).toThrow(/ceiling/);
  });
});

describe('what the child inherits', () => {
  // Restored rather than left set: --isolate gives each FILE its own process,
  // not each test, so a variable one test plants is visible to every test
  // after it in this file.
  afterEach(() => {
    delete process.env.BODHI_TEST_INHERITED;
  });

  test("the gate's env is added to the parent's, not swapped for it", async () => {
    // A gate with no inherited env cannot find git, gh or python, and the
    // plugin shells out to all three. It would fail in a way that reads like a
    // broken repo rather than a broken launch.
    //
    // Asserted on a variable this test sets, NOT on PATH: bun's spawn injects
    // a Windows floor (PATH, SYSTEMROOT, TEMP and nine more) even when `env`
    // replaces the parent's, so a PATH assertion passes against an
    // implementation that inherits nothing.
    process.env.BODHI_TEST_INHERITED = 'from the parent';
    const command = printGate('unused');
    command.argv = [
      '-e',
      'process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,' +
        'structured_output:{inherited:process.env.BODHI_TEST_INHERITED??null,' +
        'root:process.env.BODHI_ROOT}}))',
      '--json-schema',
      '{}',
      '--session-id',
      SESSION,
    ];
    const outcome = await run(command);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    expect(outcome.structuredOutput).toEqual({ inherited: 'from the parent', root: '/root' });
  });

  test('the prompt reaches the gate on stdin, not in argv', async () => {
    const command = printGate('unused');
    command.argv = [
      '-e',
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(' +
        'JSON.stringify({type:"result",subtype:"success",is_error:false,' +
        'structured_output:{prompt:s}})))',
      '--json-schema',
      '{}',
      '--session-id',
      SESSION,
    ];
    const outcome = await run(command);
    if (outcome.status !== 'completed') throw new Error(`expected completed, got ${outcome.status}`);
    expect(outcome.structuredOutput).toEqual({ prompt: 'review the diff' });
    expect(command.argv.join(' ')).not.toContain('review the diff');
  });

  test('a background gate still gets its stdin closed', async () => {
    // A CLI reading a non-TTY stdin to EOF hangs forever on input that is
    // never coming. Without the close this test times out rather than fails.
    const outcome = await run(
      backgroundGate('let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(0))'),
      { timeoutMs: 5_000 },
    );
    expect(outcome.status).toBe('launched');
  });
});
