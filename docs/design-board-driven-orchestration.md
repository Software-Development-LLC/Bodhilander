# Design: board-driven orchestration (internalize the workflow)

**Status:** proposal, for reaction. Supersedes the harness-based front-end of the
run engine (CO-722). The engine *core* stays; the front-end and the domain-data
source change.

---

## Why change

The run engine (CO-722) drives the gate flow well, but its **front-end** — how
work gets in and where domain knowledge lives — leans on the external
`claude-team-workflow` harness, and that seam is where the friction is:

- An **external harness clone** must be present, path-configured, and version-pinned per run.
- A **bundled `registry.yaml`** lists repos/owners; adding or renaming a project means editing a versioned file (the live shakeout picked `bodhi-demo-services` vs `bodhi-provider-demo-service` off it and hit exactly this).
- **Python scripts** (`file_scope`, `spawn`, `provision`, `verify_seams`, …) are a second runtime to carry.
- Work is modeled as **prepared initiative folders** (`team.yaml`/`seams.yaml`), a layer parallel to where the team already tracks work: **GitHub project boards**.
- Gates run on the CLI's **ambient `claude` login**; an expired OAuth fails every gate ([#327](https://github.com/Software-Development-LLC/Bodhilander/issues/327)).

The team already plans work on **GitHub Projects v2** boards (issues with status,
approval, assignees, linked PRs, and an Initiative→Epic→Task hierarchy). The
proposal: **drive directly off the board**, internalize the mechanical bits in
TypeScript (no Python, no external harness), and keep domain data in a
**central, runtime-fetched config** so new projects need no app release.

---

## The model

**Unit of work = a board item.** A project is a Projects v2 board (e.g. #17
"Bodhi Pulse"). An item is **eligible to start** when its **`Approved for
Development` = `Approved`** and it is not `Done`.

**Cross-repo is the board's own hierarchy.** A tracking **`[Initiative]`** issue
(e.g. `[CO-130]`, in `bodhi-code`) has **child issues across repos** via GitHub's
parent/sub-issue link:

```
[CO-130][Initiative]  bodhi-code            ← the run
 ├─ [BSA-2561][Epic]  bodhi-service-api     ← an owner track
 ├─ [BSI-141][Epic]   bodhi-service-insights
 └─ [BWA-3733][Epic]  bodhi-web-apps
```

So **an Initiative = a multi-owner run**, and **each child issue = one owner
track** — the exact shape the engine already drives. The involved repos come
from the children's `Repository`; no registry needed to know "which repos."

**Continuous mode.** When an initiative's tracks reach done / awaiting-review /
good-to-merge, the project can optionally pull the **next `Approved` item** and
keep moving, instead of stopping per run.

**In the app**, the Runs surface becomes issue-centric: for a project, show
**in-progress** initiatives (the active-runs list we built) and let a person
**initiate** an eligible (`Approved`) one — replacing "prepare & arm a folder."

---

## Where the data lives (the load-bearing decision)

Split by **who owns the truth** and **how often it changes**, so nothing about
projects is ever baked into the app build:

### 1. GitHub Projects v2 — structure, read live
Projects, items, the Initiative→child hierarchy, **which repos an item touches**,
`Status`, `Approved for Development`, `Assignees`, `Linked pull requests`,
tracking keys (in titles). Read at runtime via the Projects v2 GraphQL API.
Adding/updating a project or issue is just using GitHub; the app re-reads it.
The engine also **writes `Status` back** (decided — see below), so the app's
token needs the **`project`** scope (read + write): `gh auth refresh -s project`.

### 2. A central **config repo** — the policy GitHub doesn't hold, fetched at runtime
One org repo (e.g. `Software-Development-LLC/bodhi-orchestration-config`) the app
**fetches over the API** (never bundled). Editing it updates every app on the
next read — no release. Writable by a **person or by the automation that
generates projects** ("mix of both"). It holds only what the board lacks:

```yaml
version: 1

# Per-repo domain knowledge (what the harness registry + staff agents held).
repos:
  bodhi-code:
    key_prefix: CO                 # [CO-###] in titles/PRs → this repo
    integration_branch: development
    provision: "bun install"       # run before an owner works (per repo/language)
    owner_agent: bodhi-code-lead
    context: |
      Tracking + core repo for Pulse; issues here are usually Initiatives.
  bodhi-service-insights: { key_prefix: BSI, integration_branch: development,
                            provision: "bun install", owner_agent: insights-lead,
                            context: "…" }
  bodhi-service-ml:       { key_prefix: BSML, … }

# Owners (agents): the PER-OWNER context only. The generic role behaviour
# (how an owner/reviewer/verifier works) ships IN the app and changes with it.
owners:
  bodhi-code-lead:  { context: "You own bodhi-code. Conventions: …" }
  insights-lead:    { context: "…" }

# Projects: light — most structure comes from the board. Optional context/overrides.
projects:
  17:
    name: Bodhi Pulse
    context: "Bodhi Pulse is …"
```

The format is **human- and machine-editable** on purpose (flat YAML, no
cross-references that break on partial edits) so both authoring paths work.

### 3. Local (per-machine, in Bodhilander) — only what's inherently local
Where each repo is **cloned** (the *group ↔ project ↔ folder* association) and
the machine's **accounts/paths**. Small, and never shared.

> This directly answers the concern: **project/owner/context data is runtime data,
> never a release.** The app ships a *reader + schema*, not the data.

---

## Reuse vs. replace

**Reused (the engine core — unchanged):**
- The pure per-owner state machine (`transitions.ts`) and the gate progression.
- The loop / driver / per-owner drive, the **permission inbox**, the
  **active-runs list**, concurrency lanes.
- The gate-command / gate-process machinery for launching `claude` gates.

**Replaced:**
- The external harness dependency, the pinned `--plugin-dir`, `registry.yaml`.
- The **Python** scripts → TypeScript (below).
- The `team.yaml`/`seams.yaml` **folder/initiative** model → the board + a
  per-run working record.
- The **prepare/arm** front-end → a **board-driven** front-end (list, initiate,
  continuous mode).

**Retire deliberately:** the just-merged harness bootstrap (scope/arch-via-Python,
folder model) is removed as the board path stands up; the engine core it proved
carries forward.

---

## Dropping Python

Reimplement the mechanical bits in TS (no separate runtime):
- **Worktrees** (`spawn`): `git worktree add` per involved repo from
  `origin/<integration_branch>` — a few `git` calls via `child_process`.
- **Scope/manifest**: derive from the board (children's repos) instead of writing
  `team.yaml`; keep a small per-run working record in the DB/disk.
- **Verification** (`verify_seams`): only needed if we keep explicit cross-repo
  seam contracts (see Open questions); a TS reader/validator if so.
- **Provisioning**: inherently per-repo/per-language — it stays *data*: the
  `provision` command from the config repo, run before an owner track starts.
- **Agents**: ship the **generic** owner/reviewer/verifier prompts inside
  Bodhilander (versioned with the app); inject the **per-repo owner context**
  from the config repo at gate-launch time.

---

## The flow, end to end

1. **Read the board** (GraphQL): eligible initiatives (`Approved`, not `Done`) +
   their children + repos + status + PRs.
2. **Initiate** an initiative (a person, or continuous mode) → create a
   **multi-owner run**: owners = the children's repos, each resolved to its
   `owner_agent` via the config repo.
3. **Provision + worktrees** (TS): cut a worktree per repo, run each repo's
   `provision`.
4. **Drive** the existing per-owner gates (owner → reviewer → verifier → PR),
   with the owner's per-repo context injected. Permissions surface in the inbox;
   progress shows in the active-runs list.
5. **PRs open**; a person merges (engine never merges). Optionally the engine
   **writes Status back** to the board (Open question).
6. **Continuous**: pull the next `Approved` item for the project.

---

## Decisions

- **Board write-back — YES.** The engine updates `Status` on the board as it
  drives (→ *In Progress* when a track starts; → *Done* / awaiting-review as the
  gates complete), so the board is a live picture without hand-updating.
  Requires **`project`** (read+write) scope on the app's token
  (`gh auth refresh -s project`). **Ownership policy:** the engine owns the
  `Status` transitions it drives; **`Approved for Development` stays
  human-owned** (it's the eligibility gate), and the engine never sets approval
  or merges a PR. If a human edits `Status` mid-run, the board is source of truth
  on the next read.

## Open questions (decide before/within build)

1. **Approval authoring** — `Approved for Development` is set by a person today
   (assignee is mostly `brannon-bowden`). Keep it human-gated, or let automation
   propose it? The engine only *reads* it either way.
2. **Assignee vs owner-agent** — board assignees are people (`brannon-bowden` /
   `William-Long-II`); the working **agent** comes from the config repo
   (`repo → owner_agent`). Confirm assignee is informational, not the owner.
3. **Cross-repo contracts** — the board gives repo *membership* but not the
   producer/consumer **seams** `arch` authored. Do we still need an `arch` step
   (now a TS/in-app agent) for cross-repo contracts, or is per-repo child-issue
   scope enough?
4. **Gate auth** — pair with [#327](https://github.com/Software-Development-LLC/Bodhilander/issues/327):
   inject a managed Bodhilander account into gate spawns (vs ambient `claude`),
   which this rebuild is a natural moment to fix.
5. **Config-repo schema ownership** — versioned schema + a validator so a bad
   edit (human or machine) fails loudly, not mid-run.

---

## Phased migration (proposed)

1. **Board reader** — a read-only Projects v2 client (GraphQL): list projects,
   eligible/in-progress initiatives, children, repos, status, PRs. Surface it in
   the Runs view (no driving yet).
2. **Config repo + reader** — define the schema + a runtime fetch/validate; the
   central store replaces `registry.yaml`'s role.
3. **TS mechanical layer** — worktrees + provisioning + per-run record in TS
   (drop the Python calls), behind the existing driver deps.
4. **Initiate + drive** — wire "initiate an approved initiative" → multi-owner
   run → existing gate drive, with config-injected owner context and in-app
   agents. Retire the harness/folder front-end.
5. **Continuous mode + (optional) write-back**.

Each phase is independently shippable and reuses the engine core, so the board
path grows alongside the current one until it fully supersedes it.

## Verification
- Phase 1 is verifiable against the **real board** (#17) read-only.
- Later phases dry-run on a small `Approved` initiative with 2 child repos
  (the shakeout, redone board-driven), stopping at handoff as before.
