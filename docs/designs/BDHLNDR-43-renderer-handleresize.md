# BDHLNDR-43 — Recurring renderer `handleResize` TypeError

## Symptom

`Uncaught TypeError: Cannot read properties of undefined (reading 'handleResize')`
in `dist/renderer/renderer.js` — ×38 across gregory's log, same call site
across builds (offset shifts only with version).

## Root cause (found by building & inspecting the prod bundle)

Our source has **no** `.handleResize` property access — only two local
closures (`Terminal.tsx`, `RemoteTerminal.tsx`). Grepping the built
`renderer.js` showed every `handleResize` token is **xterm.js internal**:
`this._renderService.handleResize(cols,rows)`, `this._renderer.value.handleResize(e,t)`,
the deferred `_pausedResizeTask` closure, and the WebGL renderer.

So the undefined `.handleResize` is xterm's own renderer/renderService being
read after it's disposed/paused. Trigger: our `handleResize()` calls
`fitAddon.fit()`, which drives `terminal.resize()` → `onResize` →
`_renderService.handleResize(...)`. A resize queued **before** teardown but
delivered **during/after** it reaches torn-down xterm internals:

- The `ResizeObserver` callback scheduled `requestAnimationFrame(handleResize)`
  but that rAF was **never cancelled** on cleanup.
- `xtermRef`/`fitAddonRef` were **never nulled**, so the existing
  `if (!fitAddonRef.current || !xtermRef.current) return;` guard could not
  catch a late call — `fit()` ran on a disposed terminal.
- Window `'resize'` between `term.dispose()` and `removeEventListener`, plus
  the activation-effect rAF/`[100,250,500]ms` timer chain, hit the same path.

Same family as BDHLNDR-8 (xterm WebGL dispose race) but via the resize path,
hence the ticket's "distinct" note was only partly right.

## Fix (Terminal.tsx + RemoteTerminal.tsx — identical pattern)

1. **Track & cancel the ResizeObserver's deferred rAF** (`resizeRafId`) in
   cleanup, so it can't fire into a disposed terminal. Also `entries[0]?.`
   defensive access.
2. **Null `xtermRef`/`fitAddonRef` in cleanup** (after `term.dispose()`), so
   any residual late `handleResize` (window resize between dispose and
   listener removal, activation timers) hits the early-return guard.
3. **Wrap `fitAddon.fit()` + resize in `try/catch`** inside `handleResize` —
   final safety net (mirrors BDHLNDR-8's "never let an xterm lifecycle error
   escape to the React tree"); covers the paused-renderer / dispose micro-race
   that nulled refs alone can't fully close.

`term.dispose()` in RemoteTerminal is now also `try/catch`-wrapped for parity
with Terminal.tsx.

## Acceptance mapping

- AC1 (open/close windows, rapid session/view switching → zero `handleResize`
  `window.onerror`): addressed; empirical verification is manual (no test
  framework — documented project deviation).
- AC2 (resize behavior unchanged for live components): handleResize logic is
  unchanged on the live path; guards/try-catch only affect the teardown race.

## Verification

`build:renderer` (webpack production) green. Empirical: rapidly open/close
windows and switch sessions on a build → expect zero new `handleResize`
`window.onerror` entries (manual / next beta).
