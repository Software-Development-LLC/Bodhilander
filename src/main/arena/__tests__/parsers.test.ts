/**
 * Arena parser tests (#100). The claude fixture lines are from a real
 * `claude -p --output-format stream-json --verbose --max-turns 1` run;
 * codex/ollama fixtures follow their documented output contracts.
 *
 * Run with: bun test src/main/arena
 */
import { describe, expect, test } from 'bun:test';
import {
  claudeParser,
  codexParser,
  opencodeParser,
  kimiParser,
  cursorParser,
  textParser,
  ollamaParser,
} from '../parsers';

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

describe('opencodeParser', () => {
  // Fixtures are shapes captured from a live `opencode run --auto --format json`.
  test('extracts only text parts, captures sessionID, sums step tokens/cost', () => {
    const p = opencodeParser();
    expect(p.onLine(JSON.stringify({
      type: 'step_start', sessionID: 'ses_08e7', part: { type: 'step-start' },
    }))).toBe('');
    // A tool call must not leak into the answer.
    expect(p.onLine(JSON.stringify({
      type: 'tool_use', sessionID: 'ses_08e7', part: { type: 'tool', tool: 'read' },
    }))).toBe('');
    expect(p.onLine(JSON.stringify({
      type: 'step_finish', sessionID: 'ses_08e7',
      part: { type: 'step-finish', tokens: { input: 100, output: 5 }, cost: 0.01 },
    }))).toBe('');
    expect(p.onLine(JSON.stringify({
      type: 'text', sessionID: 'ses_08e7', part: { type: 'text', text: 'bodhilander' },
    }))).toBe('bodhilander');
    expect(p.onLine(JSON.stringify({
      type: 'step_finish', sessionID: 'ses_08e7',
      part: { type: 'step-finish', tokens: { input: 40, output: 7 }, cost: 0.02 },
    }))).toBe('');

    const final = p.finalize();
    expect(final.sessionRef).toBe('ses_08e7');
    expect(final.inputTokens).toBe(140); // summed across both step_finish events
    expect(final.outputTokens).toBe(12);
    expect(final.costUsd).toBeCloseTo(0.03, 5);
  });

  test('leaves metrics null when no step reports them', () => {
    const p = opencodeParser();
    p.onLine(JSON.stringify({ type: 'text', sessionID: 'ses_x', part: { type: 'text', text: 'hi' } }));
    const final = p.finalize();
    expect(final.inputTokens).toBeNull();
    expect(final.outputTokens).toBeNull();
    expect(final.sessionRef).toBe('ses_x');
  });
});

describe('kimiParser', () => {
  // Fixtures captured from a live `kimi -p --output-format stream-json`.
  test('emits assistant content, skips tool lines, captures resume-hint session id', () => {
    const p = kimiParser();
    // Assistant tool-call line (no string content) → skipped.
    expect(p.onLine(JSON.stringify({
      role: 'assistant',
      tool_calls: [{ type: 'function', id: 'tool_1', function: { name: 'Read', arguments: '{}' } }],
    }))).toBe('');
    // Tool result line → skipped.
    expect(p.onLine(JSON.stringify({ role: 'tool', tool_call_id: 'tool_1', content: 'file contents' }))).toBe('');
    // Assistant text → shown.
    expect(p.onLine(JSON.stringify({ role: 'assistant', content: 'zebra42' }))).toBe('zebra42');
    // Meta resume hint → captured, not shown.
    expect(p.onLine(JSON.stringify({
      role: 'meta', type: 'session.resume_hint',
      session_id: 'session_8539b109-5d48-4f7e-ad9e-25218201c205',
      command: 'kimi -r session_8539b109-5d48-4f7e-ad9e-25218201c205',
    }))).toBe('');

    const final = p.finalize();
    expect(final.sessionRef).toBe('session_8539b109-5d48-4f7e-ad9e-25218201c205');
    expect(final.inputTokens).toBeNull(); // stream-json reports no usage
  });
});

describe('cursorParser', () => {
  // Fixtures captured from a live `cursor-agent -p --output-format stream-json`.
  test('extracts assistant text, skips thinking, captures session id and camelCase usage', () => {
    const p = cursorParser();
    expect(p.onLine(JSON.stringify({
      type: 'system', subtype: 'init', apiKeySource: 'login',
      session_id: 'c701e211-bcaa-4e6c-8c5e-4334364b0b89',
    }))).toBe('');
    expect(p.onLine(JSON.stringify({
      type: 'thinking', subtype: 'delta', text: 'I will remember ',
      session_id: 'c701e211-bcaa-4e6c-8c5e-4334364b0b89',
    }))).toBe('');
    expect(p.onLine(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
      session_id: 'c701e211-bcaa-4e6c-8c5e-4334364b0b89',
    }))).toBe('OK');
    expect(p.onLine(JSON.stringify({
      type: 'result', subtype: 'success', result: 'OK',
      session_id: 'c701e211-bcaa-4e6c-8c5e-4334364b0b89',
      usage: { inputTokens: 14811, outputTokens: 37, cacheReadTokens: 128, cacheWriteTokens: 0 },
    }))).toBe('');

    const final = p.finalize();
    expect(final.sessionRef).toBe('c701e211-bcaa-4e6c-8c5e-4334364b0b89');
    expect(final.inputTokens).toBe(14811);
    expect(final.outputTokens).toBe(37);
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
