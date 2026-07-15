/**
 * Arena update merge tests (#100).
 *
 * Run with: bun test src/renderer/components/__tests__
 */
import { describe, expect, test } from 'bun:test';
import { applyArenaUpdate, isRunSettled } from '../arenaUpdates';
import { ArenaRun, ArenaUpdate } from '../../../shared/types';

function makeRun(): ArenaRun {
  return {
    id: 'run1',
    prompt: 'p',
    workingDir: null,
    createdAt: new Date(0),
    responses: [
      {
        id: 'a', runId: 'run1', provider: 'claude', status: 'running', text: 'he',
        ttftMs: 100, totalMs: null, inputTokens: null, outputTokens: null, costUsd: null, error: null,
      },
      {
        id: 'b', runId: 'run1', provider: 'grok', status: 'running', text: '',
        ttftMs: null, totalMs: null, inputTokens: null, outputTokens: null, costUsd: null, error: null,
      },
    ],
  };
}

function update(overrides: Partial<ArenaUpdate>): ArenaUpdate {
  return {
    runId: 'run1', responseId: 'a', provider: 'claude', chunk: '', status: 'running',
    ttftMs: null, totalMs: null, inputTokens: null, outputTokens: null, costUsd: null, error: null,
    ...overrides,
  };
}

describe('applyArenaUpdate', () => {
  test('appends chunks to the matching response only', () => {
    const next = applyArenaUpdate(makeRun(), update({ chunk: 'llo' }));
    expect(next.responses[0].text).toBe('hello');
    expect(next.responses[1].text).toBe('');
  });

  test('null metric fields never overwrite previously-reported values', () => {
    const next = applyArenaUpdate(makeRun(), update({ chunk: '!' }));
    expect(next.responses[0].ttftMs).toBe(100);
  });

  test('final update adopts metrics and status', () => {
    const next = applyArenaUpdate(
      makeRun(),
      update({ status: 'done', totalMs: 900, inputTokens: 2, outputTokens: 27, costUsd: 0.02 })
    );
    expect(next.responses[0]).toMatchObject({ status: 'done', totalMs: 900, outputTokens: 27, costUsd: 0.02 });
  });
});

describe('isRunSettled', () => {
  test('false while any response is running, true when all settled', () => {
    const run = makeRun();
    expect(isRunSettled(run)).toBe(false);
    let next = applyArenaUpdate(run, update({ status: 'done' }));
    expect(isRunSettled(next)).toBe(false);
    next = applyArenaUpdate(next, update({ responseId: 'b', provider: 'grok', status: 'error', error: 'x' }));
    expect(isRunSettled(next)).toBe(true);
  });
});
