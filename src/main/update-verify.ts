// Detects a macOS auto-update that quit to install but never actually landed
// (issue #294).
//
// `autoUpdater.quitAndInstall()` on macOS hands off to Squirrel.Mac's ShipIt,
// which swaps the app bundle after this process exits. When that native
// handoff silently fails — for any reason, including ones this app has no
// visibility into — the app just relaunches on the old version. Nothing in
// this app's own event stream reports an error: `update-downloaded` fired,
// `quitAndInstall()` was called, the process exited cleanly. The failure is
// invisible unless something compares "the version we restarted to install"
// against "the version we're actually running now".
//
// Kept free of any `electron` import so it is unit-testable under `bun test`.

export interface PendingInstallCheck {
  /** Set when a previous restart-to-install did not take effect. */
  failedInstall: { expected: string; actual: string } | null;
}

/**
 * Compare the version an earlier session expected to be running after
 * `quitAndInstall()` (persisted via the `pendingUpdateVersion` preference)
 * against the version actually running now.
 *
 * - No pending version recorded → nothing to verify.
 * - Pending version matches current → the install succeeded.
 * - Pending version differs from current → the install silently failed.
 *
 * Either way the caller clears the marker unconditionally: this check only
 * ever runs once per restart, so there is nothing to carry forward.
 */
export function checkPendingInstall(
  pendingVersion: string | null,
  currentVersion: string
): PendingInstallCheck {
  if (!pendingVersion || pendingVersion === currentVersion) {
    return { failedInstall: null };
  }
  return { failedInstall: { expected: pendingVersion, actual: currentVersion } };
}
