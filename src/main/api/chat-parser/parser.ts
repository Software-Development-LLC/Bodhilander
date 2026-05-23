/**
 * ChatParser (BDHLNDR-51).
 *
 * Stateful streaming classifier: consumes raw PTY chunks (ANSI included),
 * buffers incomplete trailing lines across chunks, and emits structured
 * `ChatEvent`s for the v1 taxonomy. One parser instance per session.
 *
 * Design notes:
 *  - The PTY stream is line-oriented in practice (Claude Code prints chunks
 *    that contain mostly complete lines). We split on newlines and hold any
 *    trailing partial line in `buffer` until the next chunk completes it.
 *  - ANSI is stripped for classification & extracted text, but color hints
 *    (red foreground) are read first so `error` classification can ride on
 *    Claude Code's visual error styling.
 *  - The classifier is intentionally conservative: when in doubt, emit
 *    nothing. The mobile UI shows the live terminal stream alongside chat
 *    events, so missed classifications degrade gracefully (the user still
 *    sees the raw output) whereas false positives clutter the chat view.
 *  - tool_call bodies are explicitly NOT extracted in v1 (per ticket spec).
 *    We capture the one-line header (e.g. "Read(src/foo.ts)") and stop.
 *
 * Future taxonomy expansion (tool-call bodies, file-edit diffs, bash output
 * bodies, task list updates) is out of scope — extending the discriminated
 * union in `types.ts` is the entry point when those land.
 */

import type {
  ChatEvent,
  PromptOptionsEvent,
  PromptYesNoEvent,
} from './types';

/**
 * Strip ANSI escape sequences for plain-text extraction. Small inline
 * implementation — keeping the parser dep-free per the ticket spec. Covers
 * CSI (`\x1b[…m` and friends), OSC (`\x1b]…\x07`), and standalone control
 * chars except for tabs.
 */
function stripAnsi(input: string): string {
  // Strip CSI sequences (including SGR colors, cursor moves, etc.)
  let s = input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  // Strip OSC sequences terminated by BEL or ST
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  // Strip remaining 2-byte ESC sequences (e.g. ESC + single char)
  s = s.replace(/\x1b[@-Z\\-_]/g, '');
  // Strip control chars except \n, \r, \t
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return s;
}

/** Detect a "red text" SGR sequence anywhere in the line. */
function hasRedColor(rawLine: string): boolean {
  // 31 = red fg, 91 = bright red fg, 41/101 = red bg.
  // Match within `\x1b[…m` — params separated by `;`.
  const sgrPattern = /\x1b\[((?:\d+;)*\d+)m/g;
  let match: RegExpExecArray | null;
  while ((match = sgrPattern.exec(rawLine)) !== null) {
    const params = match[1].split(';');
    for (const p of params) {
      if (p === '31' || p === '91' || p === '41' || p === '101') {
        return true;
      }
    }
  }
  return false;
}

// --- Classification patterns -------------------------------------------------

/**
 * Lines that look like a Claude Code tool-call header.
 *
 * Claude Code historically prints these with a leading bullet (●, ⏺, *) and
 * the tool name followed by parenthesised args, e.g.:
 *   "● Read(src/main/index.ts)"
 *   "⏺ Bash(npm test)"
 *   "* Edit(README.md)"
 *
 * The bullet is optional in some renders, so we accept the bare form too.
 * Capture groups: 1 = tool name, 2 = args brief.
 */
const TOOL_CALL_RE =
  /^\s*(?:[●⏺*•]\s+)?([A-Z][A-Za-z0-9_]+)\s*\(([^)]*)\)\s*$/;

/** "Error:" / "ERROR" / "API Error" line prefixes. */
const ERROR_PREFIX_RE = /^(?:\s*)(?:API\s+)?Error[:\s]/i;

/** Yes/No prompt markers anywhere on the line. */
const YES_NO_RE = /\(\s*y\s*\/\s*n\s*\)|\[\s*[Yy]\s*\/\s*[Nn]\s*\]/;

/**
 * Numbered-option prompt. Matches the trailing list portion after a question.
 * Example sources:
 *   "Pick one: [1] Approve [2] Deny [3] Skip"
 *   "Which file? 1. foo.ts 2. bar.ts 3. baz.ts"
 * Returns extracted options if at least two numbered choices are present.
 */
function extractNumberedOptions(line: string): Array<{ key: string; label: string }> | null {
  // Two accepted forms: "[N] label" or "N. label" / "N) label". Allow the
  // label to run until the next option marker (lookahead) or end of line.
  const bracketed = /\[(\d+)\]\s*([^[\n]+?)(?=\s*\[\d+\]|$)/g;
  const dotted = /(?<![.\w])(\d+)[.)]\s+([^\n]+?)(?=\s+\d+[.)]\s+|$)/g;
  const opts: Array<{ key: string; label: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = bracketed.exec(line)) !== null) {
    opts.push({ key: m[1], label: m[2].trim() });
  }
  if (opts.length >= 2) return opts;

  opts.length = 0;
  while ((m = dotted.exec(line)) !== null) {
    opts.push({ key: m[1], label: m[2].trim() });
  }
  if (opts.length >= 2) return opts;

  return null;
}

/**
 * Extract the question portion of a prompt line — everything up to (but not
 * including) the option markers. Falls back to the whole line if no marker
 * is found.
 */
function extractQuestionPrefix(line: string): string {
  // For numbered options
  const bracketIdx = line.search(/\[\d+\]/);
  if (bracketIdx > 0) return line.slice(0, bracketIdx).trim();
  const dottedIdx = line.search(/(?<![.\w])\d+[.)]\s+/);
  if (dottedIdx > 0) return line.slice(0, dottedIdx).trim();
  // For y/n
  const ynIdx = line.search(YES_NO_RE);
  if (ynIdx > 0) return line.slice(0, ynIdx).trim();
  return line.trim();
}

/** Lines that are pure terminal noise (cursor moves, blank ANSI redraws). */
function isNoise(plain: string): boolean {
  const trimmed = plain.trim();
  if (trimmed.length === 0) return true;
  // Box-drawing-only lines (Claude Code TUI frame chrome)
  if (/^[\s─-╿]+$/.test(trimmed)) return true;
  return false;
}

// --- Parser ------------------------------------------------------------------

export class ChatParser {
  /** Trailing incomplete line carried over from the previous chunk. */
  private buffer = '';

  /**
   * Consume a raw PTY chunk and return any chat events that became
   * classifiable as a result. Incomplete trailing lines are buffered for the
   * next call.
   */
  parse(chunk: string): ChatEvent[] {
    if (!chunk) return [];

    const combined = this.buffer + chunk;
    // Normalise CRLF and bare CR (carriage returns mid-stream are common
    // from progress indicators; treat them as line breaks for classification).
    const normalised = combined.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const lastNewline = normalised.lastIndexOf('\n');
    let toProcess: string;
    if (lastNewline === -1) {
      // No complete line yet — accumulate and wait.
      this.buffer = normalised;
      return [];
    }
    toProcess = normalised.slice(0, lastNewline);
    this.buffer = normalised.slice(lastNewline + 1);

    const events: ChatEvent[] = [];
    for (const rawLine of toProcess.split('\n')) {
      const event = this.classifyLine(rawLine);
      if (event) events.push(event);
    }
    return events;
  }

  /**
   * Force-flush whatever's buffered as if it were a complete line. Useful on
   * session teardown so a trailing-no-newline final message isn't lost.
   */
  flush(): ChatEvent[] {
    if (!this.buffer) return [];
    const rawLine = this.buffer;
    this.buffer = '';
    const event = this.classifyLine(rawLine);
    return event ? [event] : [];
  }

  private classifyLine(rawLine: string): ChatEvent | null {
    const isRed = hasRedColor(rawLine);
    const plain = stripAnsi(rawLine).trimEnd();

    if (isNoise(plain)) return null;

    // 1. User input echo — Claude Code renders the user message with a "> "
    //    prefix in the transcript. Distinct from terminal shell prompts (those
    //    don't appear on Claude Code stdout in interactive mode).
    if (/^>\s+\S/.test(plain)) {
      const text = plain.replace(/^>\s+/, '').trim();
      if (text.length > 0) {
        return { type: 'response', payload: { text } };
      }
    }

    // 2. Tool call — single-line header with NO body in v1.
    const toolMatch = TOOL_CALL_RE.exec(plain);
    if (toolMatch) {
      return {
        type: 'tool_call',
        payload: { tool: toolMatch[1], argsBrief: toolMatch[2].trim() },
      };
    }

    // 3. Yes/No prompt
    if (YES_NO_RE.test(plain)) {
      const question = extractQuestionPrefix(plain);
      const event: PromptYesNoEvent = {
        type: 'prompt_yes_no',
        payload: { question: question || plain },
      };
      return event;
    }

    // 4. Numbered-option prompt
    const opts = extractNumberedOptions(plain);
    if (opts) {
      const question = extractQuestionPrefix(plain);
      const event: PromptOptionsEvent = {
        type: 'prompt_options',
        payload: { question: question || plain, options: opts },
      };
      return event;
    }

    // 5. Error — explicit prefix or red color.
    if (ERROR_PREFIX_RE.test(plain) || isRed) {
      return { type: 'error', payload: { text: plain.trim() } };
    }

    // 6. Default: assistant prose. Skip if there's no real content (after
    //    stripping leading bullet chars Claude Code uses for prose markers).
    const text = plain.replace(/^[\s•●◦●⏺•]+/, '').trim();
    if (text.length === 0) return null;
    return { type: 'assistant_text', payload: { text } };
  }
}
