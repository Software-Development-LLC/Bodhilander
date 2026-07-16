/**
 * Arena repository tests — the startup sweep that settles responses a
 * quit/restart orphaned mid-run, and that finalized rows are left alone.
 *
 * Uses bun:sqlite (API-compatible with better-sqlite3 for the statements the
 * repo issues) so no native build is required to run the suite.
 *
 * Run with: bun test src/main/repositories
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

let db: Database;

mock.module('../../database', () => ({
  getDatabase: () => db,
}));

const arenaRepo = await import('../arena');

function freshDb(): Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE arena_runs (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      working_dir TEXT DEFAULT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE arena_responses (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES arena_runs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      response_text TEXT NOT NULL DEFAULT '',
      ttft_ms INTEGER DEFAULT NULL,
      total_ms INTEGER DEFAULT NULL,
      input_tokens INTEGER DEFAULT NULL,
      output_tokens INTEGER DEFAULT NULL,
      cost_usd REAL DEFAULT NULL,
      error TEXT DEFAULT NULL
    );
  `);
  return d;
}

beforeEach(() => {
  db = freshDb();
});

describe('settleInterruptedResponses', () => {
  test('settles running rows as errored and reports the count', () => {
    arenaRepo.createRun('r1', 'prompt');
    arenaRepo.createResponse('a', 'r1', 'claude');
    arenaRepo.createResponse('b', 'r1', 'codex');

    expect(arenaRepo.settleInterruptedResponses()).toBe(2);

    const run = arenaRepo.getRun('r1')!;
    for (const response of run.responses) {
      expect(response.status).toBe('error');
      expect(response.error).toBe('Interrupted by app restart');
    }
  });

  test('leaves finalized rows untouched', () => {
    arenaRepo.createRun('r1', 'prompt');
    arenaRepo.createResponse('a', 'r1', 'claude');
    arenaRepo.createResponse('b', 'r1', 'codex');
    arenaRepo.finalizeResponse('a', {
      status: 'done',
      text: 'answer',
      ttftMs: 10,
      totalMs: 20,
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.01,
      error: null,
    });

    expect(arenaRepo.settleInterruptedResponses()).toBe(1);

    const run = arenaRepo.getRun('r1')!;
    const done = run.responses.find((r) => r.id === 'a')!;
    expect(done.status).toBe('done');
    expect(done.text).toBe('answer');
    expect(done.error).toBeNull();
    expect(run.responses.find((r) => r.id === 'b')!.status).toBe('error');
  });

  test('no-op on an empty table', () => {
    expect(arenaRepo.settleInterruptedResponses()).toBe(0);
  });
});
