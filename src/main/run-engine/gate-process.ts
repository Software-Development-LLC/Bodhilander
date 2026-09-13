/**
 * Running a gate and reading what came back (CO-722).
 *
 * `buildGateCommand` decides what to run; this decides what happened. The
 * split matters because the two fail differently: a wrong argv produces a
 * gate with the wrong powers, and a wrongly-read result produces a verdict
 * nobody reached.
 *
 * Everything here is mechanical. It does not know what a reviewer looks for
 * or what makes a change acceptable — it reports whether the CLI produced a
 * validated object, launched a background session, or established nothing.
 * Turning a validated object into pass or fail is the schema's job and the
 * caller's; turning "established nothing" into a run state is the state
 * machine's.
 *
 * Three measured facts drive the whole module, and each has cost something
 * somewhere already:
 *
 * - **Success is `subtype`, `is_error` and `terminal_reason` — never
 *   `stop_reason`.** A fully successful run reports `stop_reason:
 *   "tool_use"`, so a check on it reads failure into every green gate.
 * - **A schema-valid verdict comes from `structured_output` only.** The CLI
 *   can exit 0, report `subtype: "success"`, and carry no structured output
 *   at all — measured, with `--agent` and `--json-schema` together. Parsing
 *   the `result` TEXT as a fallback is the tempting fix and the wrong one: it
 *   promotes any assistant prose that happens to look like JSON into a
 *   verdict, which is the "looks right and came from nobody" failure the
 *   command builder refuses one layer up.
 * - **`--bg` returns a launch, not an answer.** Its verdict arrives later in
 *   a receipt file, because `claude logs` is raw TUI ANSI rather than events.
 *
 * The outcome vocabulary is the plugin's, deliberately: `docs/EXIT-CODES.md`
 * in `claude-team-workflow` distinguishes "ran and answered" from "was owed
 * an answer and could not establish one", and an engine that collapsed them
 * would undo the distinction one process boundary away from where it was
 * drawn. `undriveable` here is that document's exit 2.
 */
import { spawn } from 'child_process';
import type { GateCommand } from './gate-command';
import { killTree } from '../process-tree';

export class GateSpawnError extends Error {}

/** What one gate invocation established. */
export type GateOutcome =
  /** A print gate ran and returned a schema-validated object. */
  | {
      status: 'completed';
      structuredOutput: unknown;
      sessionId: string | null;
      costUsd: number | null;
      durationMs: number;
    }
  /** A `--bg` gate started. Its verdict is the receipt, not this. */
  | {
      status: 'launched';
      /** What `claude attach` takes: the first 8 characters of the session id. */
      backgroundId: string;
      sessionId: string;
      durationMs: number;
    }
  /**
   * Nothing was established. Exit 2 in the plugin's vocabulary — NOT a
   * failing gate. Collapsing this into a fail sends an owner back to fix code
   * that was never broken; collapsing it into a pass is the defect the
   * workflow repo has now filed seven times.
   */
  | {
      status: 'undriveable';
      reason: string;
      detail: string | null;
      durationMs: number;
    };

export interface GateSpawnOptions {
  /**
   * The `claude` executable, already resolved.
   *
   * A path, never a bare name: `spawn` with `shell: false` does not search
   * PATH the way a shell does, and a shell is not an option here. The argv
   * carries a JSON schema, absolute paths and, in background mode, the whole
   * prompt — quoting that through cmd.exe or sh is a guess, and a guess that
   * silently mangles a schema produces a gate that cannot answer rather than
   * one that fails loudly.
   */
  executable: string;
  /**
   * Wall-clock ceiling. A gate that hits it is undriveable, not failed: it
   * ran to no conclusion, and reporting a result nobody observed is the lie
   * the exit-code contract exists to prevent.
   */
  timeoutMs: number;
  /** Cancellation — a person pressing stop, or the run being abandoned. */
  signal?: AbortSignal;
}

/** The `--output-format json` envelope. Only the fields this module reads. */
interface CliResult {
  subtype?: string;
  is_error?: boolean;
  terminal_reason?: string;
  structured_output?: unknown;
  session_id?: string;
  total_cost_usd?: number;
  result?: string;
}

/** Windows command lines cap at 32,767 characters, and argv is not the place to find out. */
const MAX_ARGV_CHARS = 30_000;

function argvLength(argv: string[]): number {
  return argv.reduce((n, arg) => n + arg.length + 3, 0);
}

/**
 * The mode is read from the command rather than passed alongside it.
 *
 * Two sources for one fact is two facts that can disagree, and the argv is
 * the one that decides what the process actually does.
 */
function isBackground(command: GateCommand): boolean {
  return command.argv.includes('--bg');
}

function expectsStructuredOutput(command: GateCommand): boolean {
  return command.argv.includes('--json-schema');
}

function parseResult(stdout: string): CliResult | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' ? (parsed as CliResult) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the CLI says the run itself succeeded.
 *
 * `terminal_reason` is checked only when present: it is absent on some
 * successful runs, and treating an absent field as a failure would fail every
 * gate on a CLI version that stops emitting it.
 */
function reportsSuccess(result: CliResult): boolean {
  if (result.is_error === true) return false;
  if (result.subtype !== 'success') return false;
  return result.terminal_reason === undefined || result.terminal_reason === 'completed';
}

/**
 * The first candidate with something in it, or null.
 *
 * Written out rather than chained with `||` or `??`, because neither operator
 * is right here and the two are wrong in opposite directions. `??` passes an
 * empty string through — `.trim()` returns `''`, not null, so a gate that
 * failed with no output would report `detail: ''` against a `string | null`
 * contract, and a caller rendering "detail if present" shows a blank row.
 * `||` behaves correctly and reads as a defect to any linter that sees a
 * nullable left operand (S6606, raised on exactly this line). A function says
 * the intent once: emptiness disqualifies a candidate, not nullness.
 */
function firstDetail(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (text) return text;
  }
  return null;
}

/** First 8 characters of the session id — what `claude attach` takes. */
export function backgroundIdFor(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * The `--session-id` the command names, for deriving the background id.
 *
 * Read back out of the argv rather than passed in for the same reason the
 * mode is: the id the process was actually given is the one a person will
 * have to attach to.
 */
function sessionIdIn(argv: string[]): string | null {
  const i = argv.indexOf('--session-id');
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * Run one gate to completion (print) or to launch (background).
 *
 * Never rejects on a gate that went badly — a gate that fails, times out or
 * returns nothing readable is an OUTCOME, and a run has to record it. It
 * throws only when the call itself is unusable: no executable, or an argv
 * that cannot be spawned.
 *
 * That throw is SYNCHRONOUS, before any process starts. `try { await
 * runGate(...) }` catches it; `runGate(...).catch(...)` does not, because
 * there is no promise yet to reject. Both unusable calls are programming
 * errors rather than run outcomes, which is why they are not a fourth status:
 * a run should never record "the engine called itself wrongly" as something
 * the branch did.
 */
export function runGate(command: GateCommand, options: GateSpawnOptions): Promise<GateOutcome> {
  if (!options.executable) {
    throw new GateSpawnError(
      'runGate needs a resolved path to the claude executable. A bare name cannot be ' +
        'spawned without a shell, and a shell cannot be used here: the argv carries a ' +
        'JSON schema and a prompt that no quoting rule survives intact.',
    );
  }
  const length = argvLength(command.argv);
  if (length > MAX_ARGV_CHARS) {
    throw new GateSpawnError(
      `gate command is ${length} characters of argv, over the ${MAX_ARGV_CHARS} ceiling. ` +
        "Windows' command line stops at 32,767 and fails with ENAMETOOLONG before the " +
        'process starts. Pass the large value as a file — the agent body already is one.',
    );
  }

  const startedAt = Date.now();
  const background = isBackground(command);

  return new Promise<GateOutcome>((resolve) => {
    let settled = false;
    const done = (outcome: GateOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const undriveable = (reason: string, detail: string | null = null): void =>
      done({ status: 'undriveable', reason, detail, durationMs: Date.now() - startedAt });

    const child = spawn(options.executable, command.argv, {
      cwd: command.cwd,
      // The gate's env is additive. A gate that did not inherit PATH could not
      // find git, gh or python, and the plugin shells out to all three.
      env: { ...process.env, ...command.env },
      windowsHide: true,
      // Own process group on POSIX so a cancel or a timeout reaches the whole
      // tree — the CLI starts its own children, and they hold the worktree.
      detached: process.platform !== 'win32',
    });

    const timer = setTimeout(() => {
      killTree(child);
      undriveable(
        `the gate did not finish within ${options.timeoutMs}ms`,
        'It ran to no conclusion. That is not a result about the change under test.',
      );
    }, options.timeoutMs);

    const onAbort = (): void => {
      killTree(child);
      undriveable('the run was cancelled before the gate finished');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    let stdout = '';
    let stderrTail = '';
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderrTail = (stderrTail + data.toString()).slice(-2000);
    });

    // Print mode delivers the prompt here, keeping it out of argv entirely —
    // no quoting, no length ceiling, and a variadic option cannot swallow it.
    // Background mode still ends the pipe: a CLI reading a non-TTY stdin to
    // EOF hangs forever on input that is never coming.
    // A gate that exits before reading its prompt leaves nothing on the other
    // end of this pipe, and POSIX answers a write to a reader-less pipe with
    // EPIPE. Unhandled that is an uncaught error inside Electron's main
    // process — the engine taken down by a gate that merely failed early.
    // Whatever the gate did is learned from `close` either way.
    child.stdin?.on('error', () => undefined);
    if (command.stdin !== null) child.stdin?.end(command.stdin);
    else child.stdin?.end();

    child.on('error', (err) => {
      undriveable(`the gate could not be started: ${err.message}`, options.executable);
    });

    child.on('close', (code) => {
      if (settled) return;
      const durationMs = Date.now() - startedAt;

      if (background) {
        // A launch, not an answer. Exit 0 is the whole signal available: the
        // verdict arrives later in the receipt, because `claude logs` returns
        // raw TUI ANSI rather than events.
        if (code !== 0) {
          undriveable(
            `the background gate exited ${code ?? 'on a signal'} instead of launching`,
            firstDetail(stderrTail),
          );
          return;
        }
        const sessionId = sessionIdIn(command.argv);
        if (!sessionId) {
          // Not recoverable by guessing. Without the id nothing can attach to
          // this gate, reconcile it, or resume it — so recording it as running
          // would create a session the engine could never speak to again.
          undriveable(
            'the background gate launched with no --session-id, so nothing can attach to it',
          );
          return;
        }
        done({
          status: 'launched',
          backgroundId: backgroundIdFor(sessionId),
          sessionId,
          durationMs,
        });
        return;
      }

      const result = parseResult(stdout);
      if (!result) {
        undriveable(
          'the gate returned output that is not the JSON result envelope',
          firstDetail(stderrTail, stdout.slice(-500)),
        );
        return;
      }
      if (!reportsSuccess(result)) {
        undriveable(
          `the gate reported ${result.subtype ?? 'no subtype'}` +
            (result.terminal_reason ? ` (${result.terminal_reason})` : ''),
          firstDetail(result.result?.slice(-500), stderrTail),
        );
        return;
      }
      if (expectsStructuredOutput(command) && result.structured_output === undefined) {
        // Measured, not defensive: a schema run can report success, exit 0,
        // and carry no structured output. The temptation is to read the
        // `result` text instead; that is how prose becomes a verdict.
        undriveable(
          'the gate succeeded but returned no structured_output, so it reached no verdict',
          'A verdict was owed here. Its absence is not a pass.',
        );
        return;
      }
      done({
        status: 'completed',
        structuredOutput: result.structured_output ?? null,
        sessionId: result.session_id ?? null,
        costUsd: result.total_cost_usd ?? null,
        durationMs,
      });
    });
  });
}
