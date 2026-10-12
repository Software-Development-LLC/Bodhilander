/**
 * Installing a downloaded macOS update on quit (the arming state machine).
 *
 * Extracted from auto-updater.ts and kept free of any electron / electron-updater
 * import so it is unit-testable under `bun test` — the same posture as
 * shutdown.ts. auto-updater.ts wires the real `autoUpdater.quitAndInstall` and
 * `markAppQuitting` into it; everything decision-shaped lives here.
 *
 * Why this exists: the guarded `before-quit` teardown ends in `app.exit(0)` to
 * clear Squirrel.Mac's "App Still Running" (-9) race, but a plain `app.exit(0)`
 * also skips electron-updater's `autoInstallOnAppQuit`. So a downloaded update
 * that the user did not "Restart Now" into never installs — it loops in pending/
 * forever. This tracks "an update is staged" and, on quit, arms the install.
 *
 * One-shot: a single quit sequence re-enters `before-quit` (quitAndInstall calls
 * app.quit again), so `arm()` clears the flag BEFORE it calls quitAndInstall and
 * is a no-op on any second call — including if quitAndInstall throws, since the
 * flag is already cleared by then.
 */

export interface MacUpdateInstaller {
  /** Record that a macOS update finished downloading and is staged in pending/. */
  markDownloaded(): void;
  /** Is a downloaded macOS update staged and not yet handled? */
  hasPending(): boolean;
  /**
   * Clear the staged flag WITHOUT installing. The explicit "Restart Now" path
   * runs its own `quitAndInstall`, so it consumes the flag to stop the
   * subsequent re-entrant `before-quit` from arming a second install.
   */
  consume(): void;
  /**
   * Arm the staged install (mirrors "Restart Now"). No-op — returning false —
   * when nothing is pending or not on macOS. Otherwise clears the flag first
   * (so it can't fire twice) and invokes the injected installer, returning true.
   * Lets a thrown installer propagate; the flag is already cleared, so the
   * caller's fallback can hard-exit safely.
   */
  arm(): boolean;
}

export interface MacUpdateInstallerDeps {
  /** process.platform === 'darwin'. When false the installer is inert. */
  isMac: boolean;
  /** The real `() => autoUpdater.quitAndInstall(...)`. */
  quitAndInstall: () => void;
  /** Called just before arming, e.g. `markAppQuitting`. */
  onArm?: () => void;
  /** Optional diagnostic sink. */
  log?: (msg: string) => void;
}

export function createMacUpdateInstaller(deps: MacUpdateInstallerDeps): MacUpdateInstaller {
  let ready = false;

  const hasPending = (): boolean => deps.isMac && ready;

  return {
    markDownloaded(): void {
      if (deps.isMac) ready = true;
    },
    hasPending,
    consume(): void {
      ready = false;
    },
    arm(): boolean {
      if (!hasPending()) return false;
      ready = false; // one-shot: clear BEFORE installing so a re-entrant quit — or a throw — can't re-arm
      deps.onArm?.();
      deps.log?.('arming pending macOS update install on quit');
      deps.quitAndInstall();
      return true;
    },
  };
}
