// Guaranteed-prompt shutdown (issue #133).
//
// On macOS, `autoUpdater.quitAndInstall()` hands off to Squirrel.Mac's ShipIt,
// which waits for THIS process to terminate and then swaps the app bundle. If
// the process is still alive shortly after the handoff, ShipIt cancels the
// install with `SQRLInstallerErrorDomain Code=-9 "App Still Running Error"` —
// the update downloads but never installs, and the app relaunches on the old
// version. Our `before-quit` handler runs async teardown (killing PTYs,
// disposing the vector-search worker, closing the DB) which can outlast ShipIt's
// tolerance, or hang outright on a wedged native worker.
//
// `runGuardedShutdown` runs that teardown but GUARANTEES the process is
// signalled to exit within `budgetMs` regardless of whether cleanup finishes,
// so ShipIt always sees the process gone in time. Kept free of any `electron`
// import so it is unit-testable under `bun test`.

export interface GuardedShutdownOptions {
  /** Async teardown. Must never throw synchronously; rejections are swallowed. */
  cleanup: () => Promise<void>;
  /** Terminates the process. Invoked exactly once. Typically `() => app.exit(0)`. */
  forceExit: () => void;
  /** Hard deadline: exit is forced this many ms after start even if cleanup hangs. */
  budgetMs: number;
  /** Optional diagnostic sink. */
  log?: (message: string) => void;
}

/**
 * Run shutdown cleanup with a hard exit deadline. `forceExit` fires exactly
 * once — either when cleanup settles (resolve OR reject) or when `budgetMs`
 * elapses, whichever comes first.
 */
export function runGuardedShutdown(opts: GuardedShutdownOptions): void {
  let exited = false;
  const fire = (reason: string): void => {
    if (exited) return;
    exited = true;
    opts.log?.(reason);
    opts.forceExit();
  };

  const watchdog = setTimeout(
    () => fire('[shutdown] cleanup exceeded budget; forcing exit so the updater can install'),
    opts.budgetMs
  );
  // Don't let the watchdog itself keep the event loop alive.
  (watchdog as { unref?: () => void }).unref?.();

  // Start cleanup, but the watchdog above is the real guarantee.
  Promise.resolve()
    .then(opts.cleanup)
    .catch(() => {
      // Individual steps log their own errors; a rejected cleanup must still
      // let the process exit.
    })
    .finally(() => {
      clearTimeout(watchdog);
      fire('[shutdown] cleanup complete; exiting');
    });
}
