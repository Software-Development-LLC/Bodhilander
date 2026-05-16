# BDHLNDR-40 — Interim mitigation: vector-search indexing crash-loop circuit breaker

**Status:** interim hotfix (does not fix the underlying native crash — that is gated on the
macOS `.ips` crash report; see ticket "Investigation needed").

## Problem (from gregory's `main.log`, v3.3.0, macOS arm64)

A native crash (segfault/abort) somewhere in the indexing path (`@huggingface/transformers`
ONNX Runtime / `sqlite-vec` / `better-sqlite3`) terminates the process **silently** ~25–110 s
into indexing. Because indexing runs in a `worker_threads.Worker`, a native fault there does
**not** stay contained — it kills the whole OS process, so `worker.on('exit'|'error')` never
runs and nothing is logged.

The crash becomes an **infinite relaunch loop** because:

1. `startIndexing()` writes DB status `'indexing'` (`vector-search/index.ts`).
2. Native crash → process dies → status stays `'indexing'` (no terminal transition runs).
3. On relaunch, `useCodeSearch.ts` auto-starts indexing when status is `'pending'` **or
   `'indexing'`** (it treats a persisted `'indexing'` as "stale from an interrupted
   session"). → back to step 1.

## Why not "supervise / restart the worker"

In-process supervision cannot catch a native segfault in a `worker_threads` worker — the
whole V8/OS process is gone. True containment requires moving indexing to a separate child
process (`utilityProcess`/`child_process`). That is the **permanent fix** and remains on the
ticket; it is too large/risky for a stable hotfix and needs the root-cause frame first.

## Interim design — consecutive-crash circuit breaker

Detect "a previous indexing attempt started but the process never reached a terminal state"
(== it crashed), count consecutive occurrences, and stop auto-spawning the worker once a
threshold is hit — breaking the loop and leaving the app usable.

- **Schema:** add `consecutive_failures INTEGER DEFAULT 0` to `code_indexes`
  (in `CREATE TABLE` for new installs + `ALTER TABLE ADD COLUMN` migration for existing
  installs, mirroring the established `PRAGMA table_info` pattern in `database.ts`).
- **`startIndexing()`** (before spawning the worker): read fresh status. If it is
  `'indexing'` and this index is **not** a known in-process cancel, the prior attempt
  crashed → `incrementConsecutiveFailures()`. If the new count `>= MAX_CONSECUTIVE_INDEX_CRASHES`
  (= **2**), set status `'error'` with a clear message and `return` **without spawning the
  worker**. Otherwise log a warning and proceed (one automatic retry is still allowed).
- **`handleIndexingComplete()`** → `resetConsecutiveFailures()`.
- **`retryIndexing()`** (explicit user action) → `resetConsecutiveFailures()` so the user
  can always re-arm and try again; the breaker re-trips if it crashes again.

`'error'` is reused (no new status value → no painful SQLite CHECK-constraint rebuild). The
renderer auto-index effect does **not** auto-start on `'error'`, and `IndexStatus.tsx` /
`retryIndexing` already give a user-visible, recoverable state.

### False-positive safety

A single clean app-quit mid-index also leaves status `'indexing'`. Threshold = 2 means one
such event just costs one automatic retry (which then succeeds); only *repeated consecutive*
unfinished attempts trip the breaker. In-process cancels are excluded via the existing
`cancelledIndexes` set; `retryIndexing()` sets `'pending'` before re-entry so it is never
miscounted.

## Acceptance mapping (ticket BDHLNDR-40)

- AC2 (native fault contained / no silent main-process kill loop): **partially** — the loop
  is broken and the app stays usable after ≤2 cycles; full containment is the child-process
  follow-up.
- AC1/AC3/AC4: unchanged — still require the `.ips` root cause. Tracked on the ticket.

## Verification

No test framework exists in the repo (no vitest/jest/test script) — TDD phase is infeasible
without introducing test infra (out of scope for a production hotfix). Verification:
`tsc` typecheck + `build:main`/`build:worker`, and a logic trace of the loop scenario.
