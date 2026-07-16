/**
 * Arena round-grouping tests (follow-up rounds).
 *
 * Run with: bun test src/renderer/components/__tests__
 */
import { describe, expect, test } from 'bun:test';
import { buildColumns, canFollowUp, followUpErrorMessage } from '../arenaRounds';
import { ArenaResponse, ArenaRun } from '../../../shared/types';

function response(overrides: Partial<ArenaResponse>): ArenaResponse {
  return {
    id: 'x', runId: 'run1', provider: 'claude', round: 0, prompt: null,
    sessionRef: null, status: 'done', text: 'answer',
    ttftMs: null, totalMs: null, inputTokens: null, outputTokens: null,
    costUsd: null, error: null,
    ...overrides,
  };
}

function run(responses: ArenaResponse[]): ArenaRun {
  return { id: 'run1', prompt: 'p', workingDir: null, createdAt: new Date(0), responses };
}

describe('buildColumns', () => {
  test('groups responses per provider with rounds in order and latest exposed', () => {
    const columns = buildColumns(run([
      response({ id: 'c0', provider: 'claude', round: 0, sessionRef: 's1' }),
      response({ id: 'g0', provider: 'grok', round: 0 }),
      response({ id: 'c1', provider: 'claude', round: 1, prompt: 'more?', status: 'running' }),
    ]));
    expect(columns.map(c => c.provider)).toEqual(['claude', 'grok']);
    expect(columns[0].responses.map(r => r.id)).toEqual(['c0', 'c1']);
    expect(columns[0].latest.id).toBe('c1');
    expect(columns[1].latest.id).toBe('g0');
  });
});

describe('canFollowUp', () => {
  test('true when a settled column left a session ref', () => {
    expect(canFollowUp(run([response({ sessionRef: 's1' })]))).toBe(true);
  });

  test('true for Ollama-style columns with text but no session ref', () => {
    expect(canFollowUp(run([response({ provider: 'ollama', text: 'hi' })]))).toBe(true);
  });

  test('false while anything is still running', () => {
    expect(canFollowUp(run([
      response({ sessionRef: 's1' }),
      response({ id: 'y', provider: 'grok', status: 'running' }),
    ]))).toBe(false);
  });

  test('false when every latest round errored', () => {
    expect(canFollowUp(run([response({ status: 'error', error: 'boom', text: '', sessionRef: null })]))).toBe(false);
  });

  test('judges the latest round, not earlier ones', () => {
    expect(canFollowUp(run([
      response({ id: 'c0', round: 0, sessionRef: 's1' }),
      response({ id: 'c1', round: 1, status: 'error', error: 'boom', text: '', sessionRef: null }),
    ]))).toBe(false);
  });
});

describe('followUpErrorMessage', () => {
  test('strips the IPC remote-method wrapper down to the engine detail', () => {
    expect(followUpErrorMessage(new Error(
      "Error invoking remote method 'arena:followUp': Error: No contestant in this run can be resumed"
    ))).toBe('No contestant in this run can be resumed');
  });

  test('passes plain errors and non-Errors through', () => {
    expect(followUpErrorMessage(new Error('Arena run still has contestants running')))
      .toBe('Arena run still has contestants running');
    expect(followUpErrorMessage('boom')).toBe('boom');
  });

  test('never returns an empty message', () => {
    expect(followUpErrorMessage(new Error(''))).toBe('Follow-up failed');
  });
});
