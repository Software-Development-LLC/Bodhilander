// Single source of truth for "the app is genuinely quitting" (issue #139,
// follow-up to #133).
//
// The main window's `close` handler hides to tray instead of closing whenever
// the app is not quitting. On macOS, `autoUpdater.quitAndInstall()` CLOSES ALL
// WINDOWS and THEN calls `app.quit()`. That window `close` fires while the app
// is not yet flagged as quitting, so a naive close-to-tray handler calls
// `event.preventDefault()` and hides the window — `app.quit()` is never
// reached, `before-quit` never runs, the process never exits, and Squirrel's
// ShipIt waits forever ("App Still Running Error", Code=-9). The update then
// downloads but never installs (#133's symptom, via a different mechanism than
// #133 fixed).
//
// Every path that must bypass close-to-tray — `quitAndInstall`, `before-quit`,
// the tray "Quit" item — MUST call `markAppQuitting()` BEFORE triggering the
// quit, so the window can actually close.
//
// Kept free of any `electron` import so it is unit-testable under `bun test`.

let quitting = false;

/** True once any real-quit path has started (see `markAppQuitting`). */
export function isAppQuitting(): boolean {
  return quitting;
}

/**
 * Latch the "app is quitting" flag. Idempotent. Call this BEFORE
 * `autoUpdater.quitAndInstall()` / `app.quit()` so the main window's `close`
 * handler does not trap the quit in the system tray.
 */
export function markAppQuitting(): void {
  quitting = true;
}

/**
 * Decide whether a main-window `close` should hide to tray instead of actually
 * closing. Returns `false` (allow the real close) whenever the app is quitting,
 * so an in-progress `quitAndInstall()` / `app.quit()` is never swallowed by the
 * close-to-tray behavior.
 *
 * @param quitting        Whether the app is quitting (typically `isAppQuitting()`).
 * @param closeToTrayPref The stored `closeToTray` preference. Anything other
 *                        than the string `'false'` is treated as enabled
 *                        (close-to-tray is the default).
 */
export function shouldHideToTrayOnClose(
  quitting: boolean,
  closeToTrayPref: string | undefined
): boolean {
  if (quitting) return false;
  return closeToTrayPref !== 'false';
}
