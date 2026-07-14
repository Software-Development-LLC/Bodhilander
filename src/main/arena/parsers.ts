/**
 * Arena stream parsers (#100): turn each contestant CLI's headless output
 * into displayable text chunks plus final metrics. Pure — no process or
 * electron dependencies — so every parser is directly unit-testable.
 *
 * Verified output contracts:
 * - claude: `-p --output-format stream-json --verbose --max-turns 1` emits
 *   JSONL; `assistant` events carry text content, the final `result` event
 *   carries usage, total_cost_usd, ttft_ms and duration_ms (verified live).
 * - codex: `exec --json` emits JSONL; agent_message items carry text,
 *   `turn.completed` carries token usage (per OpenAI headless docs).
 * - grok: `-p` emits plain text.
 */

export interface ArenaFinal {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** CLI-reported time-to-first-token, when available (claude). */
  reportedTtftMs: number | null;
  /** Text only available at finalize time (single-doc output styles). */
  trailingText: string;
}

export interface ArenaStreamParser {
  /** Extract displayable text from one stdout line ('' when none). */
  onLine(line: string): string;
  /** Final metrics after the process exits. */
  finalize(): ArenaFinal;
}

const EMPTY_FINAL: ArenaFinal = {
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  reportedTtftMs: null,
  trailingText: '',
};

function tryParseJson(line: string): any {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** claude -p --output-format stream-json --verbose */
export function claudeParser(): ArenaStreamParser {
  let final: ArenaFinal = { ...EMPTY_FINAL };
  return {
    onLine(line) {
      const event = tryParseJson(line);
      if (!event) return '';
      if (event.type === 'assistant') {
        const parts: unknown[] = event.message?.content ?? [];
        return parts
          .map((p: any) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : ''))
          .join('');
      }
      if (event.type === 'result') {
        final = {
          inputTokens: asFiniteNumber(event.usage?.input_tokens),
          outputTokens: asFiniteNumber(event.usage?.output_tokens),
          costUsd: asFiniteNumber(event.total_cost_usd),
          reportedTtftMs: asFiniteNumber(event.ttft_ms),
          trailingText: '',
        };
      }
      return '';
    },
    finalize: () => final,
  };
}

/** codex exec --json */
export function codexParser(): ArenaStreamParser {
  let final: ArenaFinal = { ...EMPTY_FINAL };
  return {
    onLine(line) {
      const event = tryParseJson(line);
      if (!event) return '';
      const item = event.item;
      const itemType = item?.item_type ?? item?.type;
      if (event.type === 'item.completed' && itemType === 'agent_message' && typeof item?.text === 'string') {
        return item.text;
      }
      if (event.type === 'turn.completed') {
        const usage = event.usage ?? {};
        final = {
          ...final,
          inputTokens: asFiniteNumber(usage.input_tokens),
          outputTokens: asFiniteNumber(usage.output_tokens),
        };
      }
      return '';
    },
    finalize: () => final,
  };
}

/** Plain-text CLIs (grok -p). */
export function textParser(): ArenaStreamParser {
  return {
    onLine: (line) => line + '\n',
    finalize: () => ({ ...EMPTY_FINAL }),
  };
}

/** Ollama /api/chat streaming lines: {message:{content}, done, eval counts}. */
export function ollamaParser(): ArenaStreamParser {
  let final: ArenaFinal = { ...EMPTY_FINAL };
  return {
    onLine(line) {
      const event = tryParseJson(line);
      if (!event) return '';
      if (event.done === true) {
        final = {
          ...final,
          inputTokens: asFiniteNumber(event.prompt_eval_count),
          outputTokens: asFiniteNumber(event.eval_count),
        };
      }
      return typeof event.message?.content === 'string' ? event.message.content : '';
    },
    finalize: () => final,
  };
}
