# BDHLNDR-44 — GPU process crashes + BrowserWindow-before-ready race

Two low-severity main-process robustness gaps in `src/main/index.ts`.

## Part A — renderer/GPU crash leaves UI blank

`render-process-gone` and `child-process-gone` handlers **only logged**
(`Child process gone: GPU crashed 5` ×5 in gregory's log). Electron
auto-relaunches the GPU process, but on macOS the renderer is frequently left
blank/unresponsive, and a dead renderer is never reloaded.

**Fix:** `recoverWindowAfterCrash(reason)`:
- `render-process-gone`: ignore intentional teardown (`clean-exit`/`killed`);
  for `crashed`/`oom`/`abnormal-exit`/`launch-failed` → reload the main
  window (or recreate it if destroyed and app is ready).
- `child-process-gone` with `type === 'GPU'` (not `clean-exit`) → reload so
  the renderer re-establishes its GPU channel and re-paints.
- **Reload-storm guard:** at most `MAX_PROCESS_RELOADS` (3) within
  `RELOAD_WINDOW_MS` (60 s); past that, stop and log only — never trade a
  crash loop for a reload loop.

Tradeoff: a GPU crash where the page was actually fine still triggers one
reload. Reliably detecting "renderer actually broken" is complex; the bounded
reload is the pragmatic, documented choice and matches AC1 ("recovers
visibly, not left blank").

## Part B — "Cannot create BrowserWindow before app is ready"

Seen once during the (now-fixed, BDHLNDR-40) rapid relaunch cluster. The
normal path is already gated (`app.whenReady().then(() => { createSplashWindow();
createWindow(); })`), and `second-instance`/`activate` don't construct windows
pre-ready — the exact race under chaotic relaunch couldn't be pinpointed and
isn't reproducible.

**Fix (defensive, race-agnostic):** guard `createWindow()` and
`createSplashWindow()` — if `!app.isReady()`, defer via
`app.whenReady().then(...)` and return instead of constructing. This makes the
exception **impossible by construction** regardless of caller/timing (AC2),
without chasing an unreproducible race.

## Acceptance mapping

- AC1: renderer/GPU crash → app reloads and recovers (not blank), bounded
  against storms; behavior documented here.
- AC2: no code path can construct a `BrowserWindow` before app ready — both
  factories self-defer.

## Verification

`build:main` (tsc) green. Empirical (simulate via DevTools
`process.crash()` / GPU crash, and rapid relaunch) is manual — no test
framework (documented project deviation); suggest a pass on the next beta.
