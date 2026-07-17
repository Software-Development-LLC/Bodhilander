/**
 * Arena stream parsers (#100): turn each contestant CLI's headless output
 * into displayable text chunks plus final metrics. Pure — no process or
 * electron dependencies — so every parser is directly unit-testable.
 *
 * Verified output contracts:
 * - claude: `-p --output-format stream-json --verbose` emits JSONL;
 *   `assistant` events carry text content, the final `result` event
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
  /**
   * CLI-reported session/thread id for resuming (claude result.session_id,
   * codex thread.started.thread_id). Null for CLIs that don't report one —
   * the engine falls back to the session id it assigned upfront.
   */
  sessionRef: string | null;
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
  sessionRef: null,
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

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
          sessionRef: asNonEmptyString(event.session_id),
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
      if (event.type === 'thread.started') {
        final = { ...final, sessionRef: asNonEmptyString(event.thread_id) };
        return '';
      }
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

/**
 * opencode run --format json — newline-delimited events (verified live):
 * `{type:"text",part:{type:"text",text}}` carries assistant text; tool calls
 * (`type:"tool_use"`) and reasoning stay out; `sessionID` is on every event
 * (ses_...); `type:"step_finish"` parts report tokens.{input,output} and cost.
 * Tokens/cost sum across steps so tool-using runs report a true total.
 */
export function opencodeParser(): ArenaStreamParser {
  let final: ArenaFinal = { ...EMPTY_FINAL };
  const add = (a: number | null, b: number | null): number | null =>
    b === null ? a : (a ?? 0) + b; // null stays null until a real value appears
  return {
    onLine(line) {
      const event = tryParseJson(line);
      if (!event) return '';
      const sessionRef = asNonEmptyString(event.sessionID);
      if (sessionRef) final = { ...final, sessionRef };
      const part = event.part;
      if (event.type === 'step_finish' && part) {
        final = {
          ...final,
          inputTokens: add(final.inputTokens, asFiniteNumber(part.tokens?.input)),
          outputTokens: add(final.outputTokens, asFiniteNumber(part.tokens?.output)),
          costUsd: add(final.costUsd, asFiniteNumber(part.cost)),
        };
      }
      if (event.type === 'text' && part?.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    },
    finalize: () => final,
  };
}

/**
 * kimi -p --output-format stream-json — JSON lines (verified live). Only
 * `{role:"assistant",content:<string>}` is display text; assistant tool-call
 * lines carry no string content and role:"tool" results are skipped. The
 * session id (session_...) arrives on a
 * `{role:"meta",type:"session.resume_hint",session_id}` line. No token/cost
 * reporting in stream-json.
 */
export function kimiParser(): ArenaStreamParser {
  let final: ArenaFinal = { ...EMPTY_FINAL };
  return {
    onLine(line) {
      const event = tryParseJson(line);
      if (!event) return '';
      if (event.role === 'meta' && event.type === 'session.resume_hint') {
        const sessionRef = asNonEmptyString(event.session_id);
        if (sessionRef) final = { ...final, sessionRef };
        return '';
      }
      if (event.role === 'assistant' && typeof event.content === 'string') {
        return event.content;
      }
      return '';
    },
    finalize: () => final,
  };
}

/**
 * cursor-agent -p --output-format stream-json — Claude-shaped events (verified
 * live). `{type:"assistant",message:{content:[{type:"text",text}]}}` carries
 * text; `type:"thinking"` deltas and `type:"user"` echoes stay out; every
 * event carries `session_id` (a UUID); the final `type:"result"` reports
 * `usage.inputTokens/outputTokens` (camelCase). No cost/ttft reported.
 */
export function cursorParser(): ArenaStreamParser {
  let final: ArenaFinal = { ...EMPTY_FINAL };
  return {
    onLine(line) {
      const event = tryParseJson(line);
      if (!event) return '';
      const sessionRef = asNonEmptyString(event.session_id);
      if (sessionRef) final = { ...final, sessionRef };
      if (event.type === 'result') {
        final = {
          ...final,
          inputTokens: asFiniteNumber(event.usage?.inputTokens),
          outputTokens: asFiniteNumber(event.usage?.outputTokens),
        };
      }
      if (event.type === 'assistant') {
        const parts: unknown[] = event.message?.content ?? [];
        return parts
          .map((p: any) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : ''))
          .join('');
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
