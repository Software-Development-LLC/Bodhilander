/**
 * Running one command and waiting for what it said (CO-722).
 *
 * `gate-process` runs GATES: long, attachable, and judged on what they
 * established. This runs the short, factual ones — `gh pr view`,
 * `registry-entry`, `read-review` — where the only questions are the exit
 * code and the output.
 *
 * It never rejects. A command that could not start, timed out, or was killed
 * comes back as a `CommandResult` like any other, because every caller here
 * already reads the code and has a considered answer for each value. An
 * exception would bypass that reasoning entirely, and the reasoning is the
 * part that took the work.
 *
 * Two codes are synthesised, both borrowed from the shell conventions the
 * plugin's own scripts already use:
 *
 *     127  could not be started — the binary is not there
 *     124  did not finish in time
 *
 * Neither can collide with a real answer from these tools: `registry-entry`
 * and `read-review` answer 0, 1, 2 or 3, and `gh` answers 0 or 1.
 */
import { spawn } from 'child_process';
import { killTree } from '../process-tree';
import type { CommandResult, ReconcileDeps } from './reconcile';

/** Could not be started. POSIX's "command not found", borrowed deliberately. */
export const NOT_STARTED = 127;
/** Did not finish in time. POSIX `timeout(1)`'s code, borrowed the same way. */
export const TIMED_OUT = 124;

export interface RunCommandOptions {
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string>;
  /** Delivered on stdin and then closed. A review body arrives this way. */
  stdin?: string;
  signal?: AbortSignal;
}

/**
 * How much of a stream is kept: enough to diagnose, and a hard bound.
 *
 * Hard, not approximate. Checking the length before appending lets one chunk
 * land whole on top of a nearly-full buffer, so the real ceiling becomes this
 * plus whatever the OS happened to hand over — which is not what a caller
 * reading "bounded" would plan for. `keep` truncates the chunk instead.
 */
export const MAX_CAPTURE = 1_000_000;

function keep(captured: string, chunk: Buffer): string {
  if (captured.length >= MAX_CAPTURE) return captured;
  return captured + chunk.toString().slice(0, MAX_CAPTURE - captured.length);
}

export function runCommand(
  executable: string,
  argv: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let settled = false;
    const done = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const child = spawn(executable, [...argv], {
      cwd: options.cwd,
      // Additive, like a gate's. A child with no PATH cannot find git, and gh
      // shells out to git constantly.
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const timer = setTimeout(() => {
      killTree(child);
      done({
        code: TIMED_OUT,
        stdout: '',
        stderr: `${executable} did not finish within ${options.timeoutMs}ms`,
      });
    }, options.timeoutMs);

    const onAbort = (): void => {
      killTree(child);
      done({ code: TIMED_OUT, stdout: '', stderr: `${executable} was cancelled` });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data: Buffer) => {
      stdout = keep(stdout, data);
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr = keep(stderr, data);
    });

    // A command that exits before reading its input leaves nothing on the far
    // end of this pipe, and POSIX answers a write to a reader-less pipe with
    // EPIPE. Unhandled that is an uncaught error inside Electron's main
    // process — the engine taken down by a tool that merely failed early.
    // Measured on Linux CI; Windows hides it until the write is large enough.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.stdin ?? '');

    child.on('error', (err) => {
      done({ code: NOT_STARTED, stdout: '', stderr: `${executable}: ${err.message}` });
    });

    child.on('close', (code) => {
      done({ code: exitCodeOf(code), stdout, stderr });
    });
  });
}

/**
 * What `close` reported, with a signal read honestly.
 *
 * `close` gives null when the process was killed by a signal rather than
 * exiting: a crash, an OOM kill, a machine going down. `?? 0` there reads a
 * killed process as a clean success, which is the one code every caller
 * trusts most.
 *
 * Its own function because the alternative is a platform-dependent test: on
 * POSIX a SIGKILL produces the null, and on Windows the same kill produces a
 * number, so a real-process test asserting this passes on one platform for
 * the wrong reason.
 */
export function exitCodeOf(code: number | null): number {
  return code ?? NOT_STARTED;
}

export interface ProcessDepsConfig {
  /** The `gh` executable, already resolved. A bare name is not spawnable without a shell. */
  ghPath: string;
  pythonPath: string;
  /** Where `gh` runs, so it can read the repo's own auth and remote config. */
  cwd?: string;
  /**
   * `gh` talks to the network; the plugin's scripts read files. Both are
   * bounded, and both ceilings are generous: a slow answer is worth waiting
   * for once, because the alternative is a pass that reports nothing and
   * comes back in a minute to report nothing again.
   */
  ghTimeoutMs?: number;
  pluginTimeoutMs?: number;
  /**
   * Provisioning's own deadline, because it is not the same kind of work.
   *
   * A plugin read answers in about a second, so a minute is already generous
   * for it. Provisioning runs the repo's installer, which resolves a
   * dependency tree and compiles native modules -- minutes on a cold
   * worktree, and longer on the first one a machine has ever cut. The
   * default is 15 minutes: long enough that a slow install finishes, short
   * enough that an install waiting on a prompt nobody will answer still ends.
   */
  provisionTimeoutMs?: number;
}

/**
 * What `processDeps` hands back: the reconciler's dependencies, plus the one
 * the executor needs. Provisioning is not the reconciler's business, but it
 * is spawned the same way and belongs beside the calls it shares a shape with.
 */
export type ProcessDeps = ReconcileDeps & {
  provision(argv: readonly string[]): Promise<CommandResult>;
};

/**
 * The real `gh` and the real plugin, shaped as the reconciler's dependencies.
 *
 * The seam exists so every failure meaning in `reconcile.ts` can be asserted
 * against a fake — which is where they belong, because they are decisions
 * rather than plumbing. This is the plumbing.
 */
export function processDeps(config: ProcessDepsConfig): ProcessDeps {
  // Both plugin calls spawn the same way; only the clock differs, and the
  // clock is the whole point of there being two of them.
  const pluginCall = (timeoutMs: number) => (argv: readonly string[], stdin?: string) => {
    // The argv already starts with the interpreter -- `pluginScriptArgv`
    // builds it that way so the .sh wrappers, which Windows cannot spawn
    // without a shell, are never involved.
    const [executable, ...rest] = argv;
    return runCommand(executable ?? config.pythonPath, rest, {
      timeoutMs,
      cwd: config.cwd,
      stdin,
      // Without these the plugin's em-dashes arrive as replacement
      // characters on Windows, and those lines end up in run notes.
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
  };
  return {
    gh: (argv) =>
      runCommand(config.ghPath, argv, {
        timeoutMs: config.ghTimeoutMs ?? 30_000,
        cwd: config.cwd,
      }),
    plugin: pluginCall(config.pluginTimeoutMs ?? 60_000),
    provision: pluginCall(config.provisionTimeoutMs ?? 900_000),
  };
}
