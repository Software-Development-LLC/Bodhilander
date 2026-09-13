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
import type { RunState } from '../run-engine/transitions';

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
  status: string;
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
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
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
}

export function createRun(input: CreateRunInput): void {
  getDatabase()
    .prepare(
      `INSERT INTO runs (id, initiative_key, initiative_dir, harness_path, bodhi_root,
                         python_path, permission_posture, budget_usd, group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
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
        WHERE state NOT IN ('approved', 'done', 'failed')
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

/** Mirror team.yaml's owners block. Re-runnable: spawn.sh is idempotent too. */
export function upsertOwner(owner: RunOwnerRow): void {
  getDatabase()
    .prepare(
      `INSERT INTO run_owners (run_id, repo, worktree, branch, base, scratch, status,
                               pr_number, pr_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, repo) DO UPDATE SET
         worktree = excluded.worktree,
         branch   = excluded.branch,
         base     = excluded.base,
         scratch  = excluded.scratch,
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
      owner.status,
      owner.prNumber ?? null,
      owner.prUrl ?? null,
    );
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
    status: string;
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
    status: row.status,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
  }));
}
/** One attempt at one gate. */
export interface RunGateRow {
  id: string;
  runId: string;
  gate: number;
  agent: string;
  attempt: number;
  /** What `claude attach` takes. Null until a background gate reports one. */
  bgSessionId: string | null;
  claudeSessionId: string | null;
  status: string;
  verdictJson: string | null;
  posture: PermissionPosture;
}

export interface StartGateInput {
  id: string;
  runId: string;
  gate: number;
  agent: string;
  posture: PermissionPosture;
  claudeSessionId?: string | null;
  bgSessionId?: string | null;
}

/**
 * Record a gate as running, and say which attempt this is.
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
      `INSERT INTO run_gates (id, run_id, gate, agent, attempt, bg_session_id,
                              claude_session_id, status, posture)
       SELECT ?, ?, ?, ?,
              (SELECT COUNT(*) + 1 FROM run_gates WHERE run_id = ? AND gate = ?),
              ?, ?, 'running', ?`,
    )
    .run(
      input.id,
      input.runId,
      input.gate,
      input.agent,
      input.runId,
      input.gate,
      input.bgSessionId ?? null,
      input.claudeSessionId ?? null,
      input.posture,
    );
}

/**
 * Close a gate out.
 *
 * `verdict` is stored as given, including an inconclusive one. A gate that
 * established nothing is a row worth keeping: it is the difference between a
 * run that was never attempted and one that was attempted and could not be
 * judged, and only the second means somebody should look at the harness.
 */
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
  agent: string;
  attempt: number;
  bg_session_id: string | null;
  claude_session_id: string | null;
  status: string;
  verdict_json: string | null;
  posture: string;
}): RunGateRow {
  return {
    id: row.id,
    runId: row.run_id,
    gate: row.gate,
    agent: row.agent,
    attempt: row.attempt,
    bgSessionId: row.bg_session_id,
    claudeSessionId: row.claude_session_id,
    status: row.status,
    verdictJson: row.verdict_json,
    posture: row.posture as PermissionPosture,
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
 */
export function activeGate(runId: string): RunGateRow | null {
  const row = getDatabase()
    .prepare(
      `SELECT * FROM run_gates
        WHERE run_id = ? AND status = 'running'
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(runId);
  return row ? toGateRow(row as Parameters<typeof toGateRow>[0]) : null;
}

/** Every attempt at every gate, oldest first: this is a history. */
export function listGates(runId: string): RunGateRow[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM run_gates WHERE run_id = ? ORDER BY rowid ASC')
    .all(runId) as Parameters<typeof toGateRow>[0][];
  return rows.map(toGateRow);
}
