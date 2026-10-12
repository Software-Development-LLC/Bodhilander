# Running the run engine (beta tester guide)

The run engine drives the claude-team-workflow gate process for you: once a run
is **armed**, the app provisions it, launches each gate (owner → reviewer →
verifier → scribe), answers to the daemon, opens the PR, and reads its checks —
on its own, on a timer. You watch the **Runs** view and answer the few things
only a person can.

This is a **beta**. It has driven a real single-repo initiative from arm to a
merged PR unattended, but it is new. If something looks wrong, capture what the
Runs view showed and file it (see *Reporting* below).

---

## One-time setup

Open **Settings → Run Engine** and set:

| Field | What it is |
|---|---|
| **harness path** | Your `claude-team-workflow` clone (e.g. `C:\work\repos\claude-team-workflow`). Needed to arm a run and to list its repos. |
| **workspace root (BODHI_ROOT)** | The folder holding the repo clones worktrees are cut from (e.g. `C:\work\repos`). |
| **initiatives folder** | Where a prepared initiative is written. |
| **claude / gh / python paths** | Leave blank to use whatever's on `PATH`. Make sure `gh auth status` is signed in — every check and review the engine reads comes through `gh`. |

Each field falls back to its `BODHI_*` environment variable, then a default, so
a machine that already exports those keeps working. If a path is wrong, arming
**refuses with a clear list** of what to fix rather than failing silently.

---

## Single-repo run (fully in-app)

1. **Runs** view → **Prepare & arm**. Pick the repo, enter the issue id (use a
   real GitHub issue number so the owner can read the task), optionally a
   budget → **Prepare & arm**.
2. That's it. The loop picks the run up within a minute: it provisions once,
   opens gate 2, and drives from there. Watch the **Runs** view.
3. When a gate asks for permission, the run appears in the **inbox** tagged with
   the tool and the repo. **Allow** or **Deny** (a deny can carry a reason the
   agent reads back).
4. The run walks itself to an open PR with green checks and an approving review.
   **You press merge** — the engine never merges for you.

You can arm **several runs at once**; they drive in parallel and one run's long
gate no longer freezes the others.

---

## Cross-repo run (bootstrap in the harness, drive in the app)

A cross-repo initiative's seam manifest is authored by the **`arch`** agent
(it reads code across the repos — there's no mechanical shortcut), so for this
beta you bootstrap it in the harness once, then arm it in the app. Driving
`arch` from the app is the next beta.

1. Bootstrap the initiative with the harness (this cuts the worktrees and
   writes `team.yaml` + `seams.yaml`), following your team-workflow's cross-repo
   flow — `arch` writes the manifest, then `spawn.sh` cuts the worktrees.
2. In the app: **Runs → Arm a run…** → pick that prepared initiative directory.
3. Drive and answer exactly as single-repo. Each repo runs on its own track; the
   inbox shows which repo each permission belongs to, and the armed view shows
   the **merge order** so you merge the approved PRs in sequence.

---

## What the engine will and won't do

- **Will**: provision, launch gates, answer the daemon, open the PR, read its
  checks and reviews, and stop and ask you when a tool needs permission or a
  gate can't establish a verdict.
- **Won't**: decide a verdict, or press merge. Those stay a person's.
- A run that "can't be driven here" reports **inconclusive** (a needs-a-person
  state) rather than a false pass or fail — that's correct, not a bug.

---

## Reporting

If a run stalls or does something surprising, capture from the **Runs** view:
the run's state and its blocked reason, which gate/repo it's on, and anything in
the inbox. Include the initiative id and, if a PR was opened, its number. A run
that sits in `preparing` usually means a machine-config path is wrong — check
the **Run Engine** settings; arming's refusal list names the fix.
