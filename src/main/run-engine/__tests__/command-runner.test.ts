/**
 * Command-runner tests (CO-722).
 *
 * Real child processes, for the reason `gate-process`'s tests give: what this
 * module does IS spawn, capture and classify, so a mocked `spawn` would
 * assert my beliefs about how a process behaves rather than how one does.
 * `process.execPath` stands in for `gh` and for python.
 *
 * The EPIPE test is here because CI found that bug in the other runner and it
 * would have been just as fatal in this one: a tool that exits before reading
 * its input takes down Electron's main process, and the review body this
 * module writes to stdin is exactly the case.
 *
 * Run with: bun test src/main/run-engine
 */
import { describe, expect, test } from 'bun:test';
import { NOT_STARTED, TIMED_OUT, exitCodeOf, processDeps, runCommand } from '../command-runner';

const node = (script: string): string[] => ['-e', script];

describe('what a command said', () => {
  test('stdout and the code come back together', async () => {
    const result = await runCommand(
      process.execPath,
      node('process.stdout.write("{}"); process.exit(0)'),
      { timeoutMs: 10_000 },
    );
    expect(result).toEqual({ code: 0, stdout: '{}', stderr: '' });
  });

  test('a non-zero code is reported, not thrown', async () => {
    // Every caller reads the code and has a considered answer for each
    // value. An exception would bypass that reasoning entirely.
    const result = await runCommand(
      process.execPath,
      node('process.stderr.write("not in registry.yaml"); process.exit(2)'),
      { timeoutMs: 10_000 },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not in registry.yaml');
  });

  test('stderr is kept even when the command succeeded', async () => {
    const result = await runCommand(
      process.execPath,
      node('process.stderr.write("warning"); process.stdout.write("ok")'),
      { timeoutMs: 10_000 },
    );
    expect(result).toEqual({ code: 0, stdout: 'ok', stderr: 'warning' });
  });
});

describe('the two synthesised codes', () => {
  test('a binary that is not there is 127, not a rejected promise', async () => {
    const result = await runCommand(`${process.execPath}.not-here`, [], { timeoutMs: 10_000 });
    expect(result.code).toBe(NOT_STARTED);
    expect(result.stderr).toContain('not-here');
  });

  test('a command that overruns is 124', async () => {
    const result = await runCommand(process.execPath, node('setTimeout(() => {}, 60000)'), {
      timeoutMs: 300,
    });
    expect(result.code).toBe(TIMED_OUT);
    expect(result.stderr).toContain('did not finish');
  });

  test('neither code can collide with a real answer', () => {
    // registry-entry and read-review answer 0, 1, 2 or 3; gh answers 0 or 1.
    // A synthesised code that overlapped would be read as a verdict.
    expect([0, 1, 2, 3]).not.toContain(NOT_STARTED);
    expect([0, 1, 2, 3]).not.toContain(TIMED_OUT);
    expect(NOT_STARTED).not.toBe(TIMED_OUT);
  });

  test('a cancel reports rather than leaving the caller waiting', async () => {
    const controller = new AbortController();
    const pending = runCommand(process.execPath, node('setTimeout(() => {}, 60000)'), {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.code).toBe(TIMED_OUT);
    expect(result.stderr).toContain('cancelled');
  });

  test('a process killed by a signal is not reported as success', () => {
    // `close` gives null for a signal, and `?? 0` there would read a crash as
    // a clean exit — the code every caller trusts most.
    //
    // Asserted on the mapping rather than by killing a real process, because
    // that test is platform-dependent: POSIX produces the null, Windows
    // produces a number, so on Windows it would pass for the wrong reason
    // against an implementation that maps null to 0. It did.
    expect(exitCodeOf(null)).toBe(NOT_STARTED);
    expect(exitCodeOf(null)).not.toBe(0);
  });

  test('and a real exit code is passed through untouched', () => {
    // CONTROL: a mapping that answered NOT_STARTED for everything would
    // satisfy the case above and make every command look unstartable.
    for (const code of [0, 1, 2, 3]) expect(exitCodeOf(code)).toBe(code);
  });

  test('a process that really is killed still reports non-zero', async () => {
    // The end-to-end half, which is worth keeping even though it cannot fail
    // on Windows: on Linux CI it exercises the null path for real.
    const result = await runCommand(
      process.execPath,
      node('process.kill(process.pid, "SIGKILL")'),
      { timeoutMs: 10_000 },
    );
    expect(result.code).not.toBe(0);
  });
});

describe('stdin', () => {
  test('a body is delivered and the pipe is closed', async () => {
    // Closed, because a CLI reading a non-TTY stdin to EOF hangs forever on
    // input that is never coming.
    const result = await runCommand(
      process.execPath,
      node('let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s))'),
      { timeoutMs: 10_000, stdin: '<!-- arbiter:verdict=approve -->' },
    );
    expect(result.stdout).toBe('<!-- arbiter:verdict=approve -->');
  });

  test('a command that exits before reading its input does not take us down', async () => {
    // CI found this in gate-process on Linux: POSIX answers a write to a
    // reader-less pipe with EPIPE, and unhandled it is an uncaught error
    // inside Electron's main process. A body large enough not to fit the pipe
    // buffer reproduces it on both platforms.
    const result = await runCommand(process.execPath, node('process.exit(3)'), {
      timeoutMs: 10_000,
      stdin: 'x'.repeat(256 * 1024),
    });
    expect(result.code).toBe(3);
  });

  test('no stdin still closes the pipe', async () => {
    // `resume()` matters and is not noise: a paused stdin never emits `end`
    // at all, so without it this passes against a runner that leaves the pipe
    // open and fails against one that closes it correctly. The first draft
    // omitted it and reported exactly that.
    const result = await runCommand(
      process.execPath,
      node('process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("closed"))'),
      { timeoutMs: 10_000 },
    );
    expect(result.stdout).toBe('closed');
  });
});

describe('the environment a command inherits', () => {
  test('env is added to the parent’s, never swapped for it', async () => {
    // A child with no PATH cannot find git, and gh shells out to git
    // constantly. Asserted on a variable this test sets, because bun's spawn
    // injects a Windows floor (PATH, SYSTEMROOT, TEMP and nine more) even
    // when `env` replaces the parent's — so a PATH assertion passes against
    // an implementation that inherits nothing.
    process.env.BODHI_RUNNER_INHERITED = 'from the parent';
    const result = await runCommand(
      process.execPath,
      node(
        'process.stdout.write(JSON.stringify({' +
          'inherited: process.env.BODHI_RUNNER_INHERITED ?? null,' +
          'added: process.env.PYTHONUTF8 ?? null }))',
      ),
      { timeoutMs: 10_000, env: { PYTHONUTF8: '1' } },
    );
    delete process.env.BODHI_RUNNER_INHERITED;
    expect(JSON.parse(result.stdout)).toEqual({ inherited: 'from the parent', added: '1' });
  });
});

describe('the reconciler’s dependencies', () => {
  test('the plugin call runs the interpreter the argv names', async () => {
    // pluginScriptArgv puts the interpreter first precisely so the .sh
    // wrappers, which Windows cannot spawn without a shell, are never
    // involved. This asserts the runner honours that rather than reaching for
    // its configured python.
    const deps = processDeps({ ghPath: 'gh', pythonPath: '/not/this/one' });
    const result = await deps.plugin([process.execPath, ...node('process.stdout.write("ran")')]);
    expect(result).toEqual({ code: 0, stdout: 'ran', stderr: '' });
  });

  test('the plugin call passes a body on stdin', async () => {
    const deps = processDeps({ ghPath: 'gh', pythonPath: process.execPath });
    const result = await deps.plugin(
      [process.execPath, ...node('let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s))')],
      'the review body',
    );
    expect(result.stdout).toBe('the review body');
  });

  test('a missing gh is an outcome the reconciler can read', async () => {
    // It becomes a `problem` rather than an event: gh being absent is not
    // evidence about the branch, and it may well be there next time.
    const deps = processDeps({ ghPath: `${process.execPath}.not-here` });
    const result = await deps.gh(['pr', 'view', '1']);
    expect(result.code).toBe(NOT_STARTED);
  });
});
