/**
 * Arena parser tests (#100). The claude fixture lines are from a real
 * `claude -p --output-format stream-json --verbose --max-turns 1` run;
 * codex/ollama fixtures follow their documented output contracts.
 *
 * Run with: bun test src/main/arena
 */
import { describe, expect, test } from 'bun:test';
import { claudeParser, codexParser, textParser, ollamaParser } from '../parsers';

describe('claudeParser', () => {
  test('extracts assistant text and result metrics from stream-json', () => {
    const p = claudeParser();
    expect(p.onLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toBe('');
    expect(
      p.onLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'pong' }] },
      }))
    ).toBe('pong');
    expect(
      p.onLine(JSON.stringify({
        type: 'result',
        subtype: 'success',
        duration_ms: 5973,
        ttft_ms: 5423,
        result: 'pong',
        session_id: '7f3e9a10-1111-4222-8333-944445555666',
        total_cost_usd: 0.194027,
        usage: { input_tokens: 2, output_tokens: 21 },
      }))
    ).toBe('');
    expect(p.finalize()).toEqual({
      inputTokens: 2,
      outputTokens: 21,
      costUsd: 0.194027,
      reportedTtftMs: 5423,
      trailingText: '',
      sessionRef: '7f3e9a10-1111-4222-8333-944445555666',
    });
  });

  test('ignores garbage and non-JSON lines', () => {
    const p = claudeParser();
    expect(p.onLine('not json')).toBe('');
    expect(p.onLine('{broken')).toBe('');
    expect(p.finalize().costUsd).toBeNull();
  });
});

describe('codexParser', () => {
  test('extracts agent messages and turn usage from exec --json', () => {
    const p = codexParser();
    // Codex mints its own thread id — the parser must surface it so
    // follow-up rounds can `codex exec resume` it.
    expect(p.onLine(JSON.stringify({ type: 'thread.started', thread_id: '019f6af3-ba0e-76d0-88c4-01952d138a85' }))).toBe('');
    expect(p.onLine(JSON.stringify({ type: 'turn.started' }))).toBe('');
    expect(
      p.onLine(JSON.stringify({
        type: 'item.completed',
        item: { item_type: 'agent_message', text: 'hello from codex' },
      }))
    ).toBe('hello from codex');
    expect(
      p.onLine(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 120, output_tokens: 45 },
      }))
    ).toBe('');
    const final = p.finalize();
    expect(final.inputTokens).toBe(120);
    expect(final.outputTokens).toBe(45);
    expect(final.sessionRef).toBe('019f6af3-ba0e-76d0-88c4-01952d138a85');
  });

  test('accepts item.type as an alternative to item_type', () => {
    const p = codexParser();
    expect(
      p.onLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'alt' } }))
    ).toBe('alt');
  });
});

describe('textParser', () => {
  test('passes lines through with newlines', () => {
    const p = textParser();
    expect(p.onLine('line one')).toBe('line one\n');
    expect(p.finalize().inputTokens).toBeNull();
  });
});

describe('ollamaParser', () => {
  test('streams message content and captures eval counts at done', () => {
    const p = ollamaParser();
    expect(p.onLine(JSON.stringify({ message: { content: 'hel' }, done: false }))).toBe('hel');
    expect(p.onLine(JSON.stringify({ message: { content: 'lo' }, done: false }))).toBe('lo');
    expect(
      p.onLine(JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 8, eval_count: 22 }))
    ).toBe('');
    const final = p.finalize();
    expect(final.inputTokens).toBe(8);
    expect(final.outputTokens).toBe(22);
  });
});
