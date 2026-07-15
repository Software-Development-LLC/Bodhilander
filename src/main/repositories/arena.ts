import { getDatabase } from '../database';
import { ArenaRun, ArenaResponse, ArenaResponseStatus } from '../../shared/types';

interface ResponseRow {
  id: string;
  run_id: string;
  provider: string;
  status: string;
  response_text: string;
  ttft_ms: number | null;
  total_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
}

function rowToResponse(row: ResponseRow): ArenaResponse {
  return {
    id: row.id,
    runId: row.run_id,
    provider: row.provider,
    status: row.status as ArenaResponseStatus,
    text: row.response_text,
    ttftMs: row.ttft_ms,
    totalMs: row.total_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    error: row.error,
  };
}

export function createRun(id: string, prompt: string, workingDir: string | null = null): void {
  getDatabase()
    .prepare('INSERT INTO arena_runs (id, prompt, working_dir) VALUES (?, ?, ?)')
    .run(id, prompt, workingDir);
}

export function createResponse(id: string, runId: string, provider: string): void {
  getDatabase()
    .prepare("INSERT INTO arena_responses (id, run_id, provider, status) VALUES (?, ?, ?, 'running')")
    .run(id, runId, provider);
}

export interface FinalizeResponseInput {
  status: ArenaResponseStatus;
  text: string;
  ttftMs: number | null;
  totalMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  error: string | null;
}

/**
 * Streamed text is held in memory by the engine and written once here at
 * completion — per-chunk DB writes would hammer sqlite for no benefit since
 * the renderer receives live text via events, not the DB.
 */
export function finalizeResponse(id: string, final: FinalizeResponseInput): void {
  getDatabase()
    .prepare(`
      UPDATE arena_responses
      SET status = ?, response_text = ?, ttft_ms = ?, total_ms = ?,
          input_tokens = ?, output_tokens = ?, cost_usd = ?, error = ?
      WHERE id = ?
    `)
    .run(
      final.status,
      final.text,
      final.ttftMs,
      final.totalMs,
      final.inputTokens,
      final.outputTokens,
      final.costUsd,
      final.error,
      id
    );
}

interface RunRow {
  id: string;
  prompt: string;
  working_dir: string | null;
  created_at: string;
}

export function getRun(id: string): ArenaRun | null {
  const db = getDatabase();
  const run = db
    .prepare('SELECT id, prompt, working_dir, created_at FROM arena_runs WHERE id = ?')
    .get(id) as RunRow | undefined;
  if (!run) return null;
  const rows = db
    .prepare('SELECT * FROM arena_responses WHERE run_id = ? ORDER BY provider')
    .all(id) as ResponseRow[];
  return {
    id: run.id,
    prompt: run.prompt,
    workingDir: run.working_dir,
    createdAt: new Date(run.created_at),
    responses: rows.map(rowToResponse),
  };
}

/** Most-recent-first run summaries (responses included for the history list). */
export function listRuns(limit: number = 50): ArenaRun[] {
  const db = getDatabase();
  const runs = db
    .prepare('SELECT id, prompt, working_dir, created_at FROM arena_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as RunRow[];
  const responsesStmt = db.prepare('SELECT * FROM arena_responses WHERE run_id = ? ORDER BY provider');
  return runs.map((run) => ({
    id: run.id,
    prompt: run.prompt,
    workingDir: run.working_dir,
    createdAt: new Date(run.created_at),
    responses: (responsesStmt.all(run.id) as ResponseRow[]).map(rowToResponse),
  }));
}
