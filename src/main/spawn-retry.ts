/**
 * Riding out a transient PTY spawn failure (robert2's macOS "posix_spawnp
 * failed").
 *
 * A macOS user hit three `Failed to create PTY session: Error: posix_spawnp
 * failed.` errors within 24s — bracketed by successful spawns moments before
 * and after, and clustered right as a remote owner connected and opened
 * sessions in a burst. A missing or non-executable spawn-helper would fail
 * EVERY time; this fails, then works, then fails, then works. That shape is
 * `posix_spawnp` returning EAGAIN: the per-user process/PTY limit momentarily
 * reached under load. node-pty discards the errno and rethrows the generic
 * "posix_spawnp failed." string, so EAGAIN never reaches the log verbatim —
 * the intermittency is how we read it.
 *
 * EAGAIN clears once a process or two is reaped, so the remedy is a short,
 * bounded, DELAYED retry — an immediate retry would just re-hit the same
 * ceiling. A permanent failure (helper missing, shell not found, wrong ABI)
 * still surfaces after the retries are spent, unchanged.
 *
 * Kept free of any electron/node-pty import so it is unit-testable under
 * `bun test` and reusable by every spawn entry point (interactive + relay).
 */

/**
 * Is this the transient, worth-retrying spawn failure?
 *
 * Matches node-pty's errno-less "posix_spawnp failed." plus the raw spellings
 * a future node-pty (or a different platform) might surface, so the same guard
 * keeps working if the underlying library starts exposing the errno.
 */
export function isTransientSpawnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /posix_spawnp failed/i.test(msg) ||
    /\bEAGAIN\b/.test(msg) ||
    /resource temporarily unavailable/i.test(msg) ||
    /\bENOMEM\b/.test(msg)
  );
}

export interface SpawnRetryOptions {
  /** How many times to retry AFTER the first attempt. Total tries = retries + 1. */
  retries?: number;
  /** Base delay; the nth retry waits delayMs * n (linear backoff). */
  delayMs?: number;
  /** Which errors are worth retrying. Defaults to {@link isTransientSpawnError}. */
  isTransient?: (err: unknown) => boolean;
  /** Injectable sleep so tests don't spend real time. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt` (a synchronous spawn thunk), retrying a transient failure with
 * linear backoff. Non-transient errors throw immediately; a transient error on
 * the final attempt throws too, so nothing is ever silently swallowed.
 */
export async function withSpawnRetry<T>(attempt: () => T, opts: SpawnRetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const delayMs = opts.delayMs ?? 250;
  const isTransient = opts.isTransient ?? isTransientSpawnError;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return attempt();
    } catch (err) {
      lastErr = err;
      // Out of budget, or not the kind of failure a retry can help: give up.
      if (i >= retries || !isTransient(err)) throw err;
      await sleep(delayMs * (i + 1));
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies the type.
  throw lastErr;
}
