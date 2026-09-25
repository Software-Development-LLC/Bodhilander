/**
 * Persistence for the run engine (CO-722).
 *
 * Every transition is recorded BEFORE it is acted on. A run outlives the
 * process that started it — a restart, a rate limit moving a gate to another
 * account, a machine closed for the night — and the only way it survives is
 * for the decision to be durable before the side effect happens. `run_events`
 * is append-only for the same reason: it is the run view, the audit trail and
 * resume, and a mutable log is none of those.
 *
 * What is NOT here: anything `team.yaml` already says. spawn.sh owns the
 * owners block, and these rows mirror it so a query does not have to parse
 * YAML. Where the two disagree the file wins.
 */
import { getDatabase } from '../database';
import { NEEDS_A_PERSON, rollupState, type RunState } from '../run-engine/transitions';
import type { RunOwnerSummary } from '../../shared/types';
import type { BootstrapState, RunKind } from '../run-engine/bootstrap';

export type PermissionPosture = 'manual' | 'denyOnPrompt' | 'bypass';

export interface RunRow {
  id: string;
  initiativeKey: string;
  initiativeDir: string;
  harnessPath: string;
  bodhiRoot: string;
  pythonPath: string | null;
  state: RunState;
  permissionPosture: PermissionPosture;
  budgetUsd: number | null;
  groupId: string | null;
  blockedReason: string | null;
  /** `'single'` (the arm-and-drive path) or `'multi'` (cross-repo bootstrap). */
  kind: RunKind;
  /** The pre-owner bootstrap sub-state; null for a single run or a done multi run. */
  bootstrapState: BootstrapState | null;
  /** The tester's in-scope repo picks for a multi run; null for single. */
  scopeRepos: string[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunOwnerRow {
  runId: string;
  repo: string;
  worktree: string;
  branch: string;
  base: string;
  scratch: string | null;
  /** The role that runs gate 2 here, once a run has resolved it. */
  agent?: string | null;
  status: string;
  /**
   * This owner's gate state (CO-722 multi-owner). Null before the run fans out
   * at `provisioned`; from then it drives this repo's track and `runs.state` is
   * a rollup of every owner's.
   */
  state: RunState | null;
  /** Why this owner stopped, paired with a blocked `state`. */
  blockedReason: string | null;
  /** This repo's index in seams.yaml's merge_order, for display. Null if unknown. */
  mergeOrder: number | null;
  prNumber: number | null;
  prUrl: string | null;
}

export interface RunEventRow {
  id: number;
  runId: string;
  at: Date;
  kind: string;
  gate: number | null;
  repo: string | null;
  payload: unknown;
}

interface RawRun {
  id: string;
  initiative_key: string;
  initiative_dir: string;
  harness_path: string;
  bodhi_root: string;
  python_path: string | null;
  state: string;
  permission_posture: string;
  budget_usd: number | null;
  group_id: string | null;
  blocked_reason: string | null;
  kind: string | null;
  bootstrap_state: string | null;
  scope_repos: string | null;
  created_at: string;
  updated_at: string;
}

function toRun(row: RawRun): RunRow {
  return {
    id: row.id,
    initiativeKey: row.initiative_key,
    initiativeDir: row.initiative_dir,
    harnessPath: row.harness_path,
    bodhiRoot: row.bodhi_root,
    pythonPath: row.python_path,
    state: row.state as RunState,
    permissionPosture: row.permission_posture as PermissionPosture,
    budgetUsd: row.budget_usd,
    groupId: row.group_id,
    blockedReason: row.blocked_reason,
    // A row written before the column existed reads NULL; treat it as single,
    // matching the NOT NULL DEFAULT the migration backfills.
    kind: (row.kind as RunKind | null) ?? 'single',
    bootstrapState: (row.bootstrap_state as BootstrapState | null) ?? null,
    scopeRepos: parseScopeRepos(row.scope_repos),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * A malformed scope_repos must not take the run view down: the run is still
 * driveable from its owners once spawned, and scope_repos is a record of the
 * picks. Anything but a JSON array of strings reads as "unknown" (null).
 */
function parseScopeRepos(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((r): r is string => typeof r === 'string')) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

export interface CreateRunInput {
  id: string;
  initiativeKey: string;
  initiativeDir: string;
  harnessPath: string;
  bodhiRoot: string;
  pythonPath?: string | null;
  permissionPosture?: PermissionPosture;
  budgetUsd?: number | null;
  groupId?: string | null;
  /** Defaults to `'single'`; a cross-repo bootstrap passes `'multi'`. */
  kind?: RunKind;
  /** The bootstrap entry sub-state for a multi run (typically `'scoping'`). */
  bootstrapState?: BootstrapState | null;
  /** The tester's in-scope repo picks for a multi run. */
  scopeRepos?: string[] | null;
}

export function createRun(input: CreateRunInput): void {
  getDatabase()
    .prepare(
      `INSERT INTO runs (id, initiative_key, initiative_dir, harness_path, bodhi_root,
                         python_path, permission_posture, budget_usd, group_id,
                         kind, bootstrap_state, scope_repos)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.initiativeKey,
      input.initiativeDir,
      input.harnessPath,
      input.bodhiRoot,
      input.pythonPath ?? null,
      input.permissionPosture ?? 'manual',
      input.budgetUsd ?? null,
      input.groupId ?? null,
      input.kind ?? 'single',
      input.bootstrapState ?? null,
      input.scopeRepos ? JSON.stringify(input.scopeRepos) : null,
    );
}

/**
 * Advance a multi run's bootstrap sub-state (CO-722). Thin by design: the
 * bootstrap is driven outside the pure machine, so its writes do not borrow
 * `recordTransition`'s blocked-state overloads. `null` clears it -- what the
 * handoff to the per-owner machine does once owners exist.
 */
export function setBootstrapState(runId: string, bootstrapState: BootstrapState | null): void {
  getDatabase()
    .prepare('UPDATE runs SET bootstrap_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(bootstrapState, runId);
}

/**
 * Set a run's top-level `state` (and its blocked reason) directly, used by the
 * bootstrap driver for the run-level moves that precede any owner -- e.g. into
 * `waitingHumanGate` at the manifest, or back to `preparing` to hand off. The
 * per-owner path uses `recordOwnerTransition` instead.
 */
export function setRunState(runId: string, state: RunState, blockedReason?: string | null): void {
  getDatabase()
    .prepare('UPDATE runs SET state = ?, blocked_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(state, blockedReason ?? null, runId);
}

/**
 * Halt a run: mark it `abandoned` (terminal) so the loop stops driving it and it
 * drops out of the active + inbox lists, keeping its row and history (CO-722).
 *
 * Deliberately does NOT touch the run's worktrees or any gate process it left
 * behind — halting is a bookkeeping act, and chasing child processes is what
 * locks the app up. Those are the operator's to clean up. Returns false when
 * there is no such run (already gone), true when it was halted.
 */
export function abandonRun(runId: string, reason = 'Halted by the operator'): boolean {
  const info = getDatabase()
    .prepare("UPDATE runs SET state = 'abandoned', blocked_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(reason, runId);
  if (info.changes > 0) appendEvent(runId, 'abandoned');
  return info.changes > 0;
}

export function getRun(id: string): RunRow | null {
  const row = getDatabase().prepare('SELECT * FROM runs WHERE id = ?').get(id) as
    | RawRun
    | undefined;
  return row ? toRun(row) : null;
}

/**
 * Runs that are not finished, newest first.
 *
 * `approved` counts as finished. Once every PR is approved and green nothing
 * further comes back, and the wait for someone to press merge is unbounded —
 * so a run sitting there is not something the engine is still doing.
 */
export function listActiveRuns(): RunRow[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM runs
        WHERE state NOT IN ('approved', 'done', 'failed', 'abandoned')
        ORDER BY created_at DESC`,
    )
    .all() as RawRun[];
  return rows.map(toRun);
}

/** What an event may carry beyond its kind. */
export interface EventDetail {
  gate?: number;
  repo?: string;
  payload?: unknown;
}

const INSERT_EVENT =
  'INSERT INTO run_events (run_id, kind, gate, repo, payload_json) VALUES (?, ?, ?, ?, ?)';

/**
 * One place that writes an event, so a column added to `run_events` cannot be
 * filled on one path and left null on the other.
 */
function insertEvent(
  db: ReturnType<typeof getDatabase>,
  runId: string,
  kind: string,
  detail?: EventDetail,
): void {
  db.prepare(INSERT_EVENT).run(
    runId,
    kind,
    detail?.gate ?? null,
    detail?.repo ?? null,
    detail?.payload === undefined ? null : JSON.stringify(detail.payload),
  );
}

/**
 * States that must say why they stopped.
 *
 * A run in the inbox saying it needs a person, without saying what for, sends
 * whoever opens it back to the event log to work it out — which is the one
 * thing the inbox exists to save them.
 */
type BlockedState = Extract<RunState, 'inconclusive' | 'failed'>;

/**
 * Move a run to `state`, recording the reason in the same transaction.
 *
 * One call, not two, because a state written without its event is a run whose
 * history has a hole exactly where someone will later ask what happened.
 *
 * The overloads make `blockedReason` REQUIRED for the states that block, so
 * omitting it is a compile error rather than an inbox entry with no reason.
 */
export function recordTransition(
  runId: string,
  state: BlockedState,
  kind: string,
  detail: EventDetail & { blockedReason: string },
): void;
export function recordTransition(
  runId: string,
  state: Exclude<RunState, BlockedState>,
  kind: string,
  detail?: EventDetail,
): void;
export function recordTransition(
  runId: string,
  state: RunState,
  kind: string,
  detail?: EventDetail & { blockedReason?: string | null },
): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE runs
          SET state = ?, blocked_reason = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(state, detail?.blockedReason ?? null, runId);
    insertEvent(db, runId, kind, detail);
  });
  tx();
}

/**
 * Move ONE owner (repo) to `state`, and recompute the run's rollup — all in one
 * transaction (CO-722 multi-owner).
 *
 * The per-owner analogue of `recordTransition`: it writes this repo's state and
 * its event, then rolls every owner's state up into `runs.state` so the
 * active-runs list and the inbox stay coherent at run granularity. The recompute
 * shares the transaction so two owners advancing cannot lose each other's write.
 *
 * `runs.state` is a lossy summary; the run's `blocked_reason` is set to the
 * reason of an owner in the winning state, so the inbox has something to show
 * until the per-owner surface (a later slice) reads each owner directly.
 */
export function recordOwnerTransition(
  runId: string,
  repo: string,
  state: 'inconclusive',
  kind: string,
  detail: EventDetail & { blockedReason: string },
): void;
export function recordOwnerTransition(
  runId: string,
  repo: string,
  // The states an owner's own track can hold: the run-level prelude
  // (preparing, provisioning) and terminal failure never appear per-owner, so
  // passing one is a compile error rather than a rollup that silently falls
  // back. `inconclusive` is the blocked overload above; it requires a reason.
  state: Exclude<RunState, 'inconclusive' | 'preparing' | 'provisioning' | 'failed'>,
  kind: string,
  detail?: EventDetail,
): void;
export function recordOwnerTransition(
  runId: string,
  repo: string,
  state: RunState,
  kind: string,
  detail?: EventDetail & { blockedReason?: string | null },
): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE run_owners SET state = ?, blocked_reason = ? WHERE run_id = ? AND repo = ?',
    ).run(state, detail?.blockedReason ?? null, runId, repo);
    // The event carries the repo, so the audit trail says which owner moved.
    insertEvent(db, runId, kind, { ...detail, repo });

    const owners = db
      .prepare('SELECT state, blocked_reason FROM run_owners WHERE run_id = ?')
      .all(runId) as { state: string | null; blocked_reason: string | null }[];
    const states = owners
      .map((o) => o.state)
      .filter((s): s is RunState => s !== null);
    // Defensive, not a normal path: the UPDATE above just set this owner's
    // state, so `states` is empty only when the repo matched no row (a caller
    // bug -- an unknown repo). Leave runs.state rather than roll up nothing.
    if (states.length === 0) return;
    const rolled = rollupState(states);
    const reason = owners.find((o) => o.state === rolled)?.blocked_reason ?? null;
    db.prepare(
      `UPDATE runs
          SET state = ?, blocked_reason = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(rolled, reason, runId);
  });
  tx();
}

/** An event that is not itself a transition — a note, a stream marker. */
export function appendEvent(runId: string, kind: string, detail?: EventDetail): void {
  insertEvent(getDatabase(), runId, kind, detail);
}

/** Oldest first: this is a history, and reading it backwards reads as nonsense. */
export function listEvents(runId: string): RunEventRow[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY id ASC')
    .all(runId) as {
    id: number;
    run_id: string;
    at: string;
    kind: string;
    gate: number | null;
    repo: string | null;
    payload_json: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    at: new Date(row.at),
    kind: row.kind,
    gate: row.gate,
    repo: row.repo,
    // A malformed payload must not take the run view down with it: the event
    // itself is the record, and its detail is a convenience.
    payload: row.payload_json ? safeParse(row.payload_json) : null,
  }));
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { unparsed: text };
  }
}

/**
 * The columns spawn.sh's owners block mirrors — everything on a `run_owners`
 * row except the engine-managed gate fields (`state`, `blockedReason`,
 * `mergeOrder`), which `recordOwnerTransition` and the merge_order parse own and
 * which re-mirroring must never touch.
 */
export type OwnerMirror = Omit<RunOwnerRow, 'state' | 'blockedReason' | 'mergeOrder'>;

/** Mirror team.yaml's owners block. Re-runnable: spawn.sh is idempotent too. */
export function upsertOwner(owner: OwnerMirror): void {
  getDatabase()
    .prepare(
      `INSERT INTO run_owners (run_id, repo, worktree, branch, base, scratch, agent,
                               status, pr_number, pr_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, repo) DO UPDATE SET
         worktree = excluded.worktree,
         branch   = excluded.branch,
         base     = excluded.base,
         scratch  = excluded.scratch,
         -- COALESCE, like the PR columns: spawn.sh is idempotent and this
         -- mirror is re-run, and a later mirror that does not carry the role
         -- must not erase the one a person chose.
         agent    = COALESCE(excluded.agent, run_owners.agent),
         status   = excluded.status,
         pr_number = COALESCE(excluded.pr_number, run_owners.pr_number),
         pr_url    = COALESCE(excluded.pr_url, run_owners.pr_url)`,
    )
    .run(
      owner.runId,
      owner.repo,
      owner.worktree,
      owner.branch,
      owner.base,
      owner.scratch ?? null,
      owner.agent ?? null,
      owner.status,
      owner.prNumber ?? null,
      owner.prUrl ?? null,
    );
}

/**
 * Record which PR an owner's branch became.
 *
 * The scribe opens it and nothing tells the engine which; the loop finds it
 * by branch and writes it here, once. Both halves together, because the
 * number without the URL cannot name the repository (`gh --repo` wants
 * `owner/name`, and the registry knows paths), and the URL without the
 * number is a string nobody queries by.
 */
export function recordOwnerPullRequest(
  runId: string,
  repo: string,
  pr: { prNumber: number; prUrl: string },
): void {
  getDatabase()
    .prepare('UPDATE run_owners SET pr_number = ?, pr_url = ? WHERE run_id = ? AND repo = ?')
    .run(pr.prNumber, pr.prUrl, runId, repo);
}

/**
 * One owner's gate state, or null before the run fans out (CO-722 multi-owner).
 *
 * The driver reads THIS owner's state to advance its track, falling back to the
 * run's state for the first transition after a run-level bootstrap, before the
 * owner has a state of its own.
 */
/**
 * Record an owner's place in the initiative's merge order (CO-722).
 *
 * Display only: the engine does not gate on it. A person merges the approved
 * PRs in this order, so the inbox can show them in it. Null when the initiative
 * declared no order (a single-repo run, or a manifest without one).
 */
export function recordOwnerMergeOrder(runId: string, repo: string, order: number | null): void {
  getDatabase()
    .prepare('UPDATE run_owners SET merge_order = ? WHERE run_id = ? AND repo = ?')
    .run(order, runId, repo);
}

export function ownerState(runId: string, repo: string): RunState | null {
  const row = getDatabase()
    .prepare('SELECT state FROM run_owners WHERE run_id = ? AND repo = ?')
    .get(runId, repo) as { state: string | null } | undefined;
  return (row?.state as RunState | null) ?? null;
}

export function listOwners(runId: string): RunOwnerRow[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM run_owners WHERE run_id = ? ORDER BY repo')
    .all(runId) as {
    run_id: string;
    repo: string;
    worktree: string;
    branch: string;
    base: string;
    scratch: string | null;
    agent: string | null;
    status: string;
    state: string | null;
    blocked_reason: string | null;
    merge_order: number | null;
    pr_number: number | null;
    pr_url: string | null;
  }[];
  return rows.map((row) => ({
    runId: row.run_id,
    repo: row.repo,
    worktree: row.worktree,
    branch: row.branch,
    base: row.base,
    scratch: row.scratch,
    agent: row.agent,
    status: row.status,
    state: (row.state as RunState | null) ?? null,
    blockedReason: row.blocked_reason,
    mergeOrder: row.merge_order,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
  }));
}
/** One attempt at one gate. */
export interface RunGateRow {
  id: string;
  runId: string;
  gate: number;
  /** Which owner's track this gate belongs to (CO-722). Null on pre-migration rows. */
  repo: string | null;
  agent: string;
  attempt: number;
  /** What `claude attach` takes. Null until a background gate reports one. */
  bgSessionId: string | null;
  claudeSessionId: string | null;
  status: string;
  verdictJson: string | null;
  posture: PermissionPosture;
  /** SQLite's CURRENT_TIMESTAMP at open: UTC, `YYYY-MM-DD HH:MM:SS`. */
  startedAt: string;
}

export interface StartGateInput {
  id: string;
  runId: string;
  gate: number;
  /** The owner (repo) this gate runs for (CO-722). Optional for single-owner callers. */
  repo?: string | null;
  agent: string;
  posture: PermissionPosture;
  claudeSessionId?: string | null;
  bgSessionId?: string | null;
}

/**
 * Record a gate as running, and say which attempt this is.
 *
 * Counted per ROLE, not per gate. Gate 4 is the verifier and then the
 * scribe, and the scribe following a green verifier is not the gate's second
 * attempt -- it is the same attempt's second half. Counting per gate would
 * make every sequence read as a retry loop, which is the one thing the
 * column exists to make visible.
 *
 * The attempt number is counted here rather than passed in, because the
 * caller that spawns a gate is not the one that remembers how many times it
 * already has — and a retry recorded as attempt 1 makes a loop look like a
 * first try in both the view and the audit trail.
 */
export function startGate(input: StartGateInput): void {
  // One statement, so the count and the insert cannot be separated by another
  // writer. Read-then-insert would let two spawns racing for the same gate
  // both read 1 and both record attempt 2 — and the attempt number exists to
  // make a retry loop visible, which two rows claiming the same attempt
  // quietly undoes.
  getDatabase()
    .prepare(
      `INSERT INTO run_gates (id, run_id, gate, repo, agent, attempt, bg_session_id,
                              claude_session_id, status, posture)
       SELECT ?, ?, ?, ?, ?,
              -- Counted per OWNER too (CO-722): two repos both at gate 4 share
              -- the verifier role, and B's first verifier is not A's retry.
              (SELECT COUNT(*) + 1 FROM run_gates
                WHERE run_id = ? AND gate = ? AND agent = ?
                  AND IFNULL(repo, '') = IFNULL(?, '')),
              ?, ?, 'running', ?`,
    )
    .run(
      input.id,
      input.runId,
      input.gate,
      input.repo ?? null,
      input.agent,
      input.runId,
      input.gate,
      input.agent,
      input.repo ?? null,
      input.bgSessionId ?? null,
      input.claudeSessionId ?? null,
      input.posture,
    );
}

/**
 * How many times one role has run a gate for one owner -- the "round" number,
 * counted exactly as `startGate` numbers `attempt` (per run/gate/agent/repo).
 * The review-round cap uses this: when a review gate has failed this many times
 * without converging, the run parks for a person instead of looping (CO-722).
 */
export function countGateRuns(runId: string, repo: string | null, gate: number, agent: string): number {
  const row = getDatabase()
    .prepare(
      `SELECT COUNT(*) AS n FROM run_gates
        WHERE run_id = ? AND gate = ? AND agent = ? AND IFNULL(repo, '') = IFNULL(?, '')`,
    )
    .get(runId, gate, agent, repo ?? null) as { n: number };
  return row.n;
}

/**
 * Close a gate out.
 *
 * `verdict` is stored as given, including an inconclusive one. A gate that
 * established nothing is a row worth keeping: it is the difference between a
 * run that was never attempted and one that was attempted and could not be
 * judged, and only the second means somebody should look at the harness.
 */
/**
 * Record which session a launched gate became.
 *
 * Known only after the spawn, because the launcher names the session and the
 * row is opened before the launcher runs. Both ids are kept: `bg_session_id`
 * is what `claude attach` and `claude agents` take, `claude_session_id` is
 * what the transcript and the hook payload carry. A gate with neither
 * recorded is a gate nothing can look at again -- which is #287 exactly.
 */
export function recordGateSession(
  id: string,
  session: { claudeSessionId: string; bgSessionId: string | null },
): void {
  getDatabase()
    .prepare('UPDATE run_gates SET claude_session_id = ?, bg_session_id = ? WHERE id = ?')
    .run(session.claudeSessionId, session.bgSessionId, id);
}

export function finishGate(id: string, status: string, verdict?: unknown): void {
  getDatabase()
    .prepare(
      `UPDATE run_gates
          SET status = ?, verdict_json = ?, ended_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    )
    .run(status, verdict === undefined ? null : JSON.stringify(verdict), id);
}

function toGateRow(row: {
  id: string;
  run_id: string;
  gate: number;
  repo: string | null;
  agent: string;
  attempt: number;
  bg_session_id: string | null;
  claude_session_id: string | null;
  status: string;
  verdict_json: string | null;
  posture: string;
  started_at: string;
}): RunGateRow {
  return {
    id: row.id,
    runId: row.run_id,
    gate: row.gate,
    repo: row.repo,
    agent: row.agent,
    attempt: row.attempt,
    bgSessionId: row.bg_session_id,
    claudeSessionId: row.claude_session_id,
    status: row.status,
    verdictJson: row.verdict_json,
    posture: row.posture as PermissionPosture,
    startedAt: row.started_at,
  };
}

/**
 * The gate this run is currently inside, or null.
 *
 * The state machine needs it to refuse a report from a gate that has already
 * been left — a stale gate-2 verdict arriving after gate 4 would otherwise
 * regress the run, which is a real ordering hazard rather than a theoretical
 * one.
 *
 * Newest first, because a gate re-spawned after a retry is the one in flight.
 *
 * With a `repo`, the active gate of THAT owner's track (CO-722 multi-owner):
 * two repos can each have a gate in flight, and answering or advancing one must
 * name which. Without it -- the single-owner callers -- the run's one running
 * gate, unchanged.
 */
export function activeGate(runId: string, repo?: string): RunGateRow | null {
  const db = getDatabase();
  const row = repo === undefined
    ? db
        .prepare(
          `SELECT * FROM run_gates
            WHERE run_id = ? AND status = 'running'
            ORDER BY rowid DESC LIMIT 1`,
        )
        .get(runId)
    : db
        .prepare(
          `SELECT * FROM run_gates
            WHERE run_id = ? AND status = 'running' AND repo = ?
            ORDER BY rowid DESC LIMIT 1`,
        )
        .get(runId, repo);
  return row ? toGateRow(row as Parameters<typeof toGateRow>[0]) : null;
}

/** Every attempt at every gate, oldest first: this is a history. */
export function listGates(runId: string): RunGateRow[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM run_gates WHERE run_id = ? ORDER BY rowid ASC')
    .all(runId) as Parameters<typeof toGateRow>[0][];
  return rows.map(toGateRow);
}

/** One line of the inbox: a run that cannot move without somebody. */
export interface InboxRow {
  id: string;
  initiativeKey: string;
  state: RunState;
  /**
   * Why it stopped, when it stopped rather than merely waited.
   *
   * Null for the states that are waiting on somebody by design -- a review in
   * progress has not gone wrong, so there is nothing to explain.
   */
  blockedReason: string | null;
  /** When it last moved. What "waiting since" is measured from. */
  since: string;
  /** The repos this run touches, for a line a person can recognise. */
  repos: string[];
  /** Per-owner live status; carries the `claude attach` id for a bypass wait. */
  owners: RunOwnerSummary[];
}

/**
 * States that need a person but not THIS person, here, now.
 *
 * `waitingReview` is the whole list, and the distinction is worth keeping
 * rather than collapsing. The state machine is right that a run cannot
 * advance without somebody: a PR sits until a reviewer answers. But that
 * somebody is a reviewer on GitHub, working from a review queue that already
 * exists, not an operator in this window. Putting it here would fill the
 * inbox with rows whose only action is "go and do your normal reviews", and
 * an inbox that lists things you cannot act on from where you are standing
 * stops being read.
 */
export const NOT_THE_OPERATOR: readonly RunState[] = ['waitingReview'];

/**
 * The states the inbox shows: every state that needs a person, minus the ones
 * that need a different person.
 *
 * DERIVED, not restated. A state added to NEEDS_A_PERSON and missed here is a
 * run nobody is ever told about -- the failure an inbox exists to prevent,
 * arriving through the inbox -- so a new state appears here by default, and
 * leaving it out has to be a deliberate line in the list above.
 */
export const INBOX_STATES: readonly RunState[] = [
  ...NEEDS_A_PERSON.filter((state) => !NOT_THE_OPERATOR.includes(state)),
  // A FAILED run is terminal — it is not "waiting" on anyone and cannot advance,
  // so it is deliberately NOT in NEEDS_A_PERSON. But it must not vanish silently:
  // the operator needs to SEE it failed and why (its blocked_reason), then
  // dismiss it. So the inbox surfaces it even though nothing can act on it but a
  // person acknowledging it. `abandoned` is excluded — that IS the acknowledged
  // state, and re-surfacing it would defeat dismissal.
  'failed',
];

/**
 * Runs waiting on the person at this window, oldest wait first.
 *
 * Oldest first because the one that has waited longest is the one most likely
 * to have been forgotten, and an inbox sorted newest-first buries it exactly
 * as it becomes urgent.
 */
export function listInbox(): InboxRow[] {
  const placeholders = INBOX_STATES.map(() => '?').join(', ');
  const rows = getDatabase()
    .prepare(
      `SELECT id, initiative_key, state, blocked_reason, updated_at
         FROM runs
        WHERE state IN (${placeholders})
        ORDER BY updated_at ASC, id ASC`,
    )
    .all(...INBOX_STATES) as {
    id: string;
    initiative_key: string;
    state: string;
    blocked_reason: string | null;
    updated_at: string;
  }[];

  // One query for the batch, not one per row -- shared with the active list so
  // the two answer "which repos, in what order" the same way.
  const ids = rows.map((row) => row.id);
  const byRun = reposByRun(ids);
  const ownersByRun = ownersSummaryByRun(ids);

  return rows.map((row) => ({
    id: row.id,
    initiativeKey: row.initiative_key,
    state: row.state as RunState,
    blockedReason: row.blocked_reason,
    since: row.updated_at,
    repos: byRun.get(row.id) ?? [],
    owners: ownersByRun.get(row.id) ?? [],
  }));
}

/**
 * The repos each run touches, in merge order (nulls last), for a set of runs.
 *
 * One query for the batch, not one per row -- the same shape `listInbox` uses,
 * lifted out so the active list and the inbox cannot answer "which repos" two
 * different ways.
 */
/**
 * Per-owner live status for a batch of runs, keyed by run id (CO-722).
 *
 * One query joining each owner to its OPEN gate (ended_at IS NULL). `attachId`
 * is the gate's background session, exposed only when the owner is a BYPASS gate
 * waiting on a person — the one case answered out of band (`claude attach`), so
 * the inbox can show the command. Every other case leaves it null.
 */
function ownersSummaryByRun(ids: string[]): Map<string, RunOwnerSummary[]> {
  const byRun = new Map<string, RunOwnerSummary[]>();
  if (ids.length === 0) return byRun;
  const rows = getDatabase()
    .prepare(
      `SELECT o.run_id AS run_id, o.repo AS repo, o.agent AS agent, o.state AS state,
              g.gate AS gate, g.bg_session_id AS bg_session_id, g.posture AS posture
         FROM run_owners o
         LEFT JOIN run_gates g
           ON g.run_id = o.run_id AND g.repo = o.repo AND g.ended_at IS NULL
        WHERE o.run_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY o.run_id ASC,
                 CASE WHEN o.merge_order IS NULL THEN 1 ELSE 0 END, o.merge_order ASC, o.repo ASC`,
    )
    .all(...ids) as {
    run_id: string;
    repo: string;
    agent: string | null;
    state: string | null;
    gate: number | null;
    bg_session_id: string | null;
    posture: string | null;
  }[];
  for (const r of rows) {
    const attachId = r.posture === 'bypass' && r.state === 'waitingPermission' ? r.bg_session_id : null;
    const summary: RunOwnerSummary = { repo: r.repo, agent: r.agent, state: r.state, gate: r.gate, attachId };
    byRun.set(r.run_id, [...(byRun.get(r.run_id) ?? []), summary]);
  }
  return byRun;
}

function reposByRun(ids: string[]): Map<string, string[]> {
  const byRun = new Map<string, string[]>();
  if (ids.length === 0) return byRun;
  const owners = getDatabase()
    .prepare(
      `SELECT run_id, repo FROM run_owners
        WHERE run_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY run_id ASC,
                 CASE WHEN merge_order IS NULL THEN 1 ELSE 0 END, merge_order ASC, repo ASC`,
    )
    .all(...ids) as { run_id: string; repo: string }[];
  for (const owner of owners) {
    byRun.set(owner.run_id, [...(byRun.get(owner.run_id) ?? []), owner.repo]);
  }
  return byRun;
}

/** One line of the active-runs list: an in-flight run and the phase it is in. */
export interface ActiveRow {
  id: string;
  initiativeKey: string;
  state: RunState;
  /** 'single' or 'multi' (CO-722): a multi run shows its bootstrap phase. */
  kind: RunKind;
  /** The pre-owner bootstrap phase for a multi run; null otherwise. */
  bootstrapState: BootstrapState | null;
  blockedReason: string | null;
  since: string;
  repos: string[];
  owners: RunOwnerSummary[];
}

/**
 * Every run still in flight, most-recently-active first (CO-722).
 *
 * Unlike the inbox -- which shows only what needs THIS person -- this is the
 * "what is the engine doing" surface: a cross-repo run scoping or driving arch
 * sits in `state='preparing'`, which the inbox excludes, so without this list it
 * is invisible for the minutes it spends bootstrapping. Newest-activity-first,
 * because this list is read to see what just moved, not to find the oldest wait.
 */
export function listActive(): ActiveRow[] {
  const rows = getDatabase()
    .prepare(
      `SELECT id, initiative_key, state, kind, bootstrap_state, blocked_reason, updated_at
         FROM runs
        WHERE state NOT IN ('approved', 'done', 'failed', 'abandoned')
        ORDER BY updated_at DESC, id ASC`,
    )
    .all() as {
    id: string;
    initiative_key: string;
    state: string;
    kind: string | null;
    bootstrap_state: string | null;
    blocked_reason: string | null;
    updated_at: string;
  }[];

  const ids = rows.map((row) => row.id);
  const byRun = reposByRun(ids);
  const ownersByRun = ownersSummaryByRun(ids);
  return rows.map((row) => ({
    id: row.id,
    initiativeKey: row.initiative_key,
    state: row.state as RunState,
    kind: (row.kind as RunKind | null) ?? 'single',
    bootstrapState: (row.bootstrap_state as BootstrapState | null) ?? null,
    blockedReason: row.blocked_reason,
    since: row.updated_at,
    repos: byRun.get(row.id) ?? [],
    owners: ownersByRun.get(row.id) ?? [],
  }));
}
