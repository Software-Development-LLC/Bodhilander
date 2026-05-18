# BDHLNDR-45 — RE-SCOPED: local crash minidump capture

## Scope change

Original ticket: move vector-search indexing `worker_threads` → Electron
`utilityProcess` to *contain* a native crash. **Superseded:** BDHLNDR-40
(circuit breaker + ONNX arena bound, v3.3.1) and BDHLNDR-46 (q8 + token cap +
migration, v3.3.3) fixed the actual crash. A full transport refactor is now
large effort for sharply reduced value, so per maintainer decision this is
re-scoped to its only remaining valuable, root-cause-agnostic residue:
**reliable local crash minidump capture**.

## Finding

`crashReporter.start({ uploadToServer: false })` already exists in
`src/main/index.ts` (added with the BDHLNDR-30 logging work). It runs at
module load — before app lifecycle — so renderer/GPU/utility crashes and
in-process `worker_threads` native faults are captured by Crashpad into
`app.getPath('crashDumps')`, already exposed via the `log:getPaths` IPC.

So the re-scoped goal was essentially already met. This change adds the two
small, high-leverage touches that directly address this session's pain (we had
to talk the user through hand-finding gregory's `.ips`):

- `extra: { appVersion: app.getVersion() }` — dumps are tagged with the
  version, so triage doesn't need the version guessed/asked.
- Startup `log.info('[CrashReporter] Native crash minidumps written to: …')`
  — the dump directory is now in `main.log`, so "where are the crash files"
  is answerable from the log alone.

Remote upload of these dumps is explicitly **out of scope** → BDHLNDR-47
(phone-home), which this complements.

## Acceptance (re-scoped)

1. Native crashes produce a local minidump in `app.getPath('crashDumps')` —
   already true; verified the start() call runs pre-lifecycle.
2. Dumps carry the app version; the dump path is logged at startup.
3. No worker→utilityProcess refactor (dropped; rationale recorded on the
   ticket).

## Verification

`build:main` (tsc) green. Empirical (trigger a native crash, confirm a
minidump + the startup log line) is manual — no test framework (documented
project deviation).
