# BDHLNDR-30: Smart Auto-Scroll for Terminal

## Problem

During long Claude Code streaming output, the xterm.js terminal viewport spontaneously jumps to random scroll positions. The jump distance varies. Root cause: xterm.js viewport loses sync during rapid `term.write()` calls.

## Solution: Smart Auto-Scroll

Before each `term.write()`, check if the user's viewport is "near the bottom" of the terminal buffer. If yes, call `scrollToBottom()` after the write to keep it pinned. If the user has intentionally scrolled up (viewport is far from bottom), leave them alone.

### Detection Logic

```
isNearBottom = (buffer.baseY - buffer.viewportY) <= SCROLL_THRESHOLD
```

- `buffer.baseY` — how many lines have scrolled off the top (grows as output streams)
- `buffer.viewportY` — current viewport scroll offset
- `SCROLL_THRESHOLD` — 5 lines of tolerance to account for minor drift

### Change Scope

**Single file:** `src/renderer/components/Terminal.tsx`

In the `onPtyData` handler (line 263-267), wrap the `term.write()` call:

1. Read `term.buffer.active.baseY` and `term.buffer.active.viewportY`
2. Determine if user is near bottom (`baseY - viewportY <= 5`)
3. Call `term.write(data)`
4. If was near bottom, call `term.scrollToBottom()`

### Fallback Plan

If smart auto-scroll is insufficient:
- **Phase 2:** Add pin-to-bottom toggle button in TerminalHeader
- **Phase 3:** Full setting in SettingsModal terminal tab

## Risk

Low — single file change, no new dependencies, no settings/IPC changes. The threshold (5 lines) can be tuned if needed.
