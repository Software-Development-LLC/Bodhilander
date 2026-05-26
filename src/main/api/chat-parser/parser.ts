/**
 * ChatParser (BDHLNDR-72 — terminal-emulator rewrite).
 *
 * Wraps a headless xterm Terminal instance per session, writes incoming PTY
 * chunks into it, and harvests committed rows from the virtual screen as
 * structured ChatEvents.
 *
 * # Why this architecture
 *
 * The previous line-based parsers (BDHLNDR-51 + the BDHLNDR-72 first-pass
 * rewrite) cannot extract meaningful events from Claude Code's stream.
 * Concrete evidence from a 5-minute capture of a real session containing
 * 3 paragraphs of prose, two tool calls, and a bash error:
 *
 *   raw bytes: 340,204    |   line-feeds: 20,026
 *   LFs preceded by printable text: 0
 *   current parser: 1572 events, longest payload "H" (single character)
 *
 * Claude Code's TUI is a full terminal-emulator app: it paints every
 * character via cursor positioning (CSI cursor-up/down/right/left + write +
 * advance). The `\n` characters in the stream are blank-line separators in
 * the TUI's frame layout, not content terminators. To extract real text we
 * must maintain a virtual screen, which is exactly what xterm-headless gives
 * us for free.
 *
 * # Model
 *
 * - One `Terminal` per session (instantiated lazily on first parse).
 * - `parse(chunk)` writes the chunk to the terminal (xterm async-decodes ANSI
 *   and updates its cell buffer) and arms a "settle" timer.
 * - On settle (default 250ms of no new chunks), `harvest()` walks the cell
 *   buffer from `harvestedUpTo` to `cursorAbsY` (exclusive of the cursor row,
 *   which is presumed mid-paint), reads each logical line (joining wrapped
 *   continuations), runs the classifier, and pushes events through the
 *   `onEvents` callback.
 * - `flush()` cancels the settle timer and harvests everything including
 *   the cursor row — used on session teardown.
 *
 * # Why a callback, not a return value
 *
 * Harvest is asynchronous (debounced). The old `parse(chunk): ChatEvent[]`
 * shape returned events synchronously, which doesn't fit a debounced model
 * where events from a chunk might not be ready until 250ms later. The
 * `onEvents` callback is invoked whenever a harvest produces events,
 * regardless of when `parse()` was last called.
 *
 * # Classification (unchanged from BDHLNDR-51, kept in sync with v1 spec)
 *
 *  1. `> user input` → `response`
 *  2. `⏺ Tool(args)` → `tool_call`
 *  3. `(y/n)` / `[Y/n]` → `prompt_yes_no`
 *  4. `[1] foo [2] bar` → `prompt_options`
 *  5. `Error:` prefix or red-coloured row → `error`
 *     (We re-detect red via re-walking the row's cells.)
 *  6. Default → `assistant_text`
 *
 * Spinner-glyph-only / loading-status / box-drawing rows are dropped as noise.
 */

import { Terminal } from '@xterm/headless';
import type {
  ChatEvent,
  PromptOptionsEvent,
  PromptYesNoEvent,
} from './types';

// BDHLNDR-73 #40: Claude Code paints with absolute cursor positioning
// (`ESC[NG`). Captured corpora show instructions up to col 209 — clamping
// at 120 caused autowrap to fuse adjacent words (`memory usage` →
// `memoryusage`, `concerns (windows,` → `concerns(windows,`). 220 covers
// observed max + headroom; xterm-headless handles wide buffers fine.
const TERM_COLS = 220;
const TERM_ROWS = 40;
const SCROLLBACK = 10_000;
/** Debounce window before harvesting (ms). */
const DEFAULT_SETTLE_MS = 250;
/** Absolute upper bound on debounce window — force a harvest even mid-burst. */
const MAX_SETTLE_MS = 1500;

// --- Classification patterns (carried over from BDHLNDR-51) ----------------

const TOOL_CALL_RE =
  /^\s*[●⏺*•◦]?\s*([A-Z][A-Za-z0-9_]+)\s*\(([^)]*)\)\s*$/;

// BDHLNDR-73: Claude Code's real TUI renders Read tool calls as
// `Reading 1 file… (ctrl+o to expand)` (pre-result) or `Read 1 file
// (ctrl+o to expand)` (post-result). Neither matches TOOL_CALL_RE.
const TOOL_CALL_READ_RE =
  /^\s*Read(?:ing)?\s+(\d+)\s+(files?)(?:\s*[…]|\s*\.\.\.)?\s*(?:\(.*\))?\s*$/;

// BDHLNDR-73: Grep/Glob render as `Searching for 1 pattern…` and
// `Searched for 1 pattern (ctrl+o to expand)`.
const TOOL_CALL_SEARCH_RE =
  /^\s*Search(?:ing|ed)\s+(?:for\s+)?(\d+)\s+(patterns?|files?)(?:\s*[…]|\s*\.\.\.)?\s*(?:\(.*\))?\s*$/;

// BDHLNDR-73: decorative tool-result header line, e.g. `──Read package.json`
// or `──── "src/main/api/**/*"──────...`. Two-or-more leading box-drawing
// chars followed by content — drop as chrome.
const DECORATIVE_HEADER_RE = /^\s*[─━]{2,}\s*\S/;

// BDHLNDR-73: bare timing line like `(3s)`, `( 12s )`, `(1m 30s)`.
const BARE_TIMING_RE =
  /^\s*\(\s*\d+\s*[smh]\s*(?:\d+\s*[smh]\s*)?\)\s*$/i;

// BDHLNDR-73: lone prompt indicator with no input after it.
const LONE_PROMPT_RE = /^\s*[>❯]\s*$/;

// BDHLNDR-73: line ending in a long run of box-drawing chars — TUI section
// header like `Shell details─────────...` (Bash tool result label expanded
// across the full pane width). Threshold of 20 keeps tree-render lines with
// short padding intact.
const TRAILING_DECORATION_RE = /[─━═]{20,}\s*$/;

const ERROR_PREFIX_RE = /^(?:\s*)(?:API\s+)?Error[:\s]/i;

const YES_NO_RE = /\(\s*y\s*\/\s*n\s*\)|\[\s*[Yy]\s*\/\s*[Nn]\s*\]/;

const SPINNER_GLYPH_ONLY_RE =
  /^[\s✶✻✽✢●○◌◍◐◑◒◓◔◕✱✦✧*·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+$/;

/**
 * Loading-status / "what claude is doing now" lines. Claude Code rotates a
 * VERY wide set of present-progressive verbs ("Sautéed", "Brewed", "Cogitated",
 * "Rewriting", "Razzle-dazzling", etc.) plus the classic "thinking" / "still
 * thinking". After ~hundreds of real frames it's clear the only stable
 * signal is the SHAPE: a leading spinner glyph, optional verb, and trailing
 * timing/token-count parenthetical OR "shell still running" etc. We match
 * that shape rather than an unbounded verb list.
 */
const LOADING_STATUS_RE =
  /^[\s✶✻✽✢●○◌◍◐◑◒◓◔◕✱✦✧*·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏][^.!?\n]*?\s*(?:\(\s*\d+[ms](?:\s|·)|\d+\s*shell|tokens|thinking|loading|generating|reasoning|pondering|musing|cogitat|deliberat|razzle[-\s]?dazzl|rewrit|sauté|brew|stew|simmer|whisk|knead)/i;

/**
 * BDHLNDR-73: shape-only catch for novel spinner verbs. Claude Code rotates
 * its verb list continuously ("Distilling…", "Crystallizing…", new ones
 * shipping in every Claude Code release) and the alternation in
 * LOADING_STATUS_RE will always lag. This catches the durable shape:
 * spinner glyph as the leading non-space char, followed by short content
 * (under ~80 chars, no terminal punctuation), ending in `…` or `...`.
 * The leading-glyph requirement keeps it from eating prose.
 */
const LOADING_STATUS_SHAPE_RE =
  /^\s*[✶✻✽✢●○◌◍◐◑◒◓◔◕✱✦✧·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏][^.!?\n]{0,80}(?:…|\.\.\.)\s*$/;

/**
 * Claude Code's TUI task-list rows (decorative): "◼ Title" / "✓ Title" /
 * "──N tasks (...)" / "⎿  bullet" — drop them as chrome.
 */
const TASK_LIST_CHROME_RE =
  /^\s*(?:[◼✓☐□✗✘■□]\s+|⎿\s+|─+\s*\d+\s+tasks?\s*\()/;

/**
 * Help / hint lines along the bottom of the TUI ("⏵⏵ auto mode on", "esc to
 * interrupt", "ctrl+t to hide tasks", "↓ to manage"). All chrome.
 */
const HELP_HINT_CHROME_RE =
  /^[\s⏵▸›❯]*\s*(?:auto\s+mode|esc\s+to|ctrl\+|↓\s+to\s+manage|shift\+tab)/i;

const BOX_DRAWING_ONLY_RE = /^[\s─-╿─━│┃═║]+$/;

function extractNumberedOptions(
  line: string,
): Array<{ key: string; label: string }> | null {
  const opts: Array<{ key: string; label: string }> = [];
  let m: RegExpExecArray | null;

  const bracketed = /\[(\d+)\]\s*([^[\n]+?)(?=\s*\[\d+\]|$)/g;
  while ((m = bracketed.exec(line)) !== null) {
    opts.push({ key: m[1], label: m[2].trim() });
  }
  if (opts.length >= 2) return opts;

  opts.length = 0;
  const dotted = /(?<![.\w])(\d+)[.)]\s+([^\n]+?)(?=\s+\d+[.)]\s+|$)/g;
  while ((m = dotted.exec(line)) !== null) {
    opts.push({ key: m[1], label: m[2].trim() });
  }
  if (opts.length >= 2) return opts;

  return null;
}

function extractQuestionPrefix(line: string): string {
  const bracketIdx = line.search(/\[\d+\]/);
  if (bracketIdx > 0) return line.slice(0, bracketIdx).trim();
  const dottedIdx = line.search(/(?<![.\w])\d+[.)]\s+/);
  if (dottedIdx > 0) return line.slice(0, dottedIdx).trim();
  const ynIdx = line.search(YES_NO_RE);
  if (ynIdx > 0) return line.slice(0, ynIdx).trim();
  return line.trim();
}

// --- Parser ----------------------------------------------------------------

export type ChatEventsCallback = (events: ChatEvent[]) => void;

export interface ChatParserOptions {
  /** Debounce window before harvesting (ms). Defaults to DEFAULT_SETTLE_MS. */
  settleMs?: number;
  /** Hard upper bound on debounce window. Defaults to MAX_SETTLE_MS. */
  maxSettleMs?: number;
  /** Terminal width in columns. Defaults to TERM_COLS. */
  cols?: number;
  /** Terminal height in rows. Defaults to TERM_ROWS. */
  rows?: number;
  /** Scrollback size. Defaults to SCROLLBACK. */
  scrollback?: number;
}

export class ChatParser {
  private term: Terminal;
  private harvestedUpTo = 0;
  private settleTimer: NodeJS.Timeout | null = null;
  /** Earliest time we'll fire a settle harvest, even during continuous writes. */
  private maxSettleDeadline: number | null = null;
  private disposed = false;
  private readonly settleMs: number;
  private readonly maxSettleMs: number;
  /**
   * Ring buffer of the last N emitted event texts — used to dedupe
   * near-consecutive duplicates. Claude Code's TUI does periodic
   * full-screen repaints (e.g. when a status row at the bottom updates,
   * the entire viewport redraws), which causes xterm to push the same
   * content into scrollback twice: once as the original paint and again
   * after the repaint. A simple "equals previous" guard misses cases
   * where a few interleaved rows (an input prompt `❯`, a status update)
   * appear between the duplicates, so we keep a small ring instead.
   */
  private recentTexts: string[] = [];
  private static readonly DEDUPE_RING_SIZE = 16;

  constructor(
    private readonly onEvents: ChatEventsCallback,
    opts: ChatParserOptions = {},
  ) {
    this.settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
    this.maxSettleMs = opts.maxSettleMs ?? MAX_SETTLE_MS;
    this.term = new Terminal({
      cols: opts.cols ?? TERM_COLS,
      rows: opts.rows ?? TERM_ROWS,
      scrollback: opts.scrollback ?? SCROLLBACK,
      allowProposedApi: true,
    });
  }

  /**
   * Feed a chunk of PTY bytes. Returns a promise that resolves once xterm
   * has finished parsing the chunk into its cell buffer. Events from this
   * (and prior) chunks are delivered later via `onEvents`, after the settle
   * window closes.
   */
  parse(chunk: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!chunk) return Promise.resolve();

    return new Promise<void>((resolve) => {
      this.term.write(chunk, () => {
        this.scheduleHarvest();
        resolve();
      });
    });
  }

  /**
   * Cancel any pending settle and harvest everything (including the cursor
   * row). Use on session teardown so trailing content isn't lost.
   */
  flush(): void {
    if (this.disposed) return;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.maxSettleDeadline = null;
    this.harvest({ includeCursorRow: true });
  }

  /** Release the underlying Terminal. After dispose, parse/flush are no-ops. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    try {
      this.term.dispose();
    } catch {
      // already disposed or shutting down — non-fatal
    }
  }

  private scheduleHarvest(): void {
    if (this.maxSettleDeadline === null) {
      this.maxSettleDeadline = Date.now() + this.maxSettleMs;
    }
    if (this.settleTimer) clearTimeout(this.settleTimer);
    const remaining = this.maxSettleDeadline - Date.now();
    const delay = Math.max(0, Math.min(this.settleMs, remaining));
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.maxSettleDeadline = null;
      this.harvest();
    }, delay);
  }

  private harvest(opts: { includeCursorRow?: boolean } = {}): void {
    if (this.disposed) return;
    const buf = this.term.buffer.active;
    const cursorAbsY = buf.baseY + buf.cursorY;
    const upTo = opts.includeCursorRow ? buf.length : cursorAbsY;

    // Defensive: scrollback shrank / screen cleared / etc. — clamp watermark.
    if (this.harvestedUpTo > upTo) {
      this.harvestedUpTo = upTo;
      return;
    }

    const events: ChatEvent[] = [];
    let y = this.harvestedUpTo;
    while (y < upTo) {
      const line = buf.getLine(y);
      if (!line) {
        y += 1;
        continue;
      }
      // A wrapped row is a continuation of the previous row — should have
      // been absorbed by the prior iteration. If we see one as the head of
      // our walk, it means the previous row was already harvested; skip.
      if (line.isWrapped) {
        y += 1;
        continue;
      }
      // Collect this logical line + wrapped continuations into one string.
      let logical = line.translateToString(true);
      // Track whether ANY cell in this logical line is red (for error class).
      let hasRed = rowHasRed(line);
      let next = y + 1;
      while (next < upTo) {
        const cont = buf.getLine(next);
        if (!cont || !cont.isWrapped) break;
        logical += cont.translateToString(true);
        if (!hasRed) hasRed = rowHasRed(cont);
        next += 1;
      }

      if (logical.trim()) {
        const event = classifyLine(logical, hasRed);
        if (event) {
          const text = eventText(event);
          if (!this.recentTexts.includes(text)) {
            events.push(event);
            this.recentTexts.push(text);
            if (this.recentTexts.length > ChatParser.DEDUPE_RING_SIZE) {
              this.recentTexts.shift();
            }
          }
        }
      }
      y = next;
    }
    this.harvestedUpTo = upTo;

    if (events.length > 0) {
      try {
        this.onEvents(events);
      } catch (err) {
        // Don't let a downstream throw break the parser pipeline.
        // eslint-disable-next-line no-console
        console.error('[ChatParser] onEvents callback threw:', err);
      }
    }
  }
}

// --- Helpers ---------------------------------------------------------------

/**
 * Walk every cell in the row and check whether any has a red foreground or
 * background colour set. Used as a fallback signal for error classification
 * when there's no explicit "Error:" prefix.
 */
/** Extract the canonical text from any event variant for dedupe comparison. */
function eventText(e: ChatEvent): string {
  switch (e.type) {
    case 'assistant_text':
    case 'error':
    case 'response':
      return e.payload.text;
    case 'tool_call':
      return `${e.payload.tool}(${e.payload.argsBrief})`;
    case 'prompt_yes_no':
      return e.payload.question;
    case 'prompt_options':
      return e.payload.question + '|' + e.payload.options.map((o) => o.key).join(',');
  }
}

function rowHasRed(line: import('@xterm/headless').IBufferLine): boolean {
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) continue;
    // ANSI red is colour index 1 (or 9 for bright red). We only care about
    // palette colours since Claude Code uses standard ANSI for error styling.
    if (cell.isFgPalette() && (cell.getFgColor() === 1 || cell.getFgColor() === 9)) return true;
    if (cell.isBgPalette() && (cell.getBgColor() === 1 || cell.getBgColor() === 9)) return true;
  }
  return false;
}

function classifyLine(line: string, hasRed: boolean): ChatEvent | null {
  const trimmed = line.trimEnd();
  if (trimmed.length === 0) return null;
  if (BOX_DRAWING_ONLY_RE.test(trimmed)) return null;
  if (SPINNER_GLYPH_ONLY_RE.test(trimmed)) return null;
  if (LOADING_STATUS_RE.test(trimmed)) return null;
  if (LOADING_STATUS_SHAPE_RE.test(trimmed)) return null;
  if (TASK_LIST_CHROME_RE.test(trimmed)) return null;
  if (HELP_HINT_CHROME_RE.test(trimmed)) return null;
  if (DECORATIVE_HEADER_RE.test(trimmed)) return null;
  if (BARE_TIMING_RE.test(trimmed)) return null;
  if (LONE_PROMPT_RE.test(trimmed)) return null;
  if (TRAILING_DECORATION_RE.test(trimmed)) return null;

  // 1. User input echo. Claude Code prefixes with `>` (older versions) or
  //    `❯` (newer). Both signal "user typed this".
  if (/^[>❯]\s+\S/.test(trimmed)) {
    const text = trimmed.replace(/^[>❯]\s+/, '').trim();
    if (text) return { type: 'response', payload: { text } };
  }

  // 2. Tool call (multiple render shapes).
  const toolMatch = TOOL_CALL_RE.exec(trimmed);
  if (toolMatch) {
    return {
      type: 'tool_call',
      payload: { tool: toolMatch[1], argsBrief: toolMatch[2].trim() },
    };
  }
  const readMatch = TOOL_CALL_READ_RE.exec(trimmed);
  if (readMatch) {
    return {
      type: 'tool_call',
      payload: { tool: 'Read', argsBrief: `${readMatch[1]} ${readMatch[2]}` },
    };
  }
  const searchMatch = TOOL_CALL_SEARCH_RE.exec(trimmed);
  if (searchMatch) {
    return {
      type: 'tool_call',
      payload: { tool: 'Grep', argsBrief: `${searchMatch[1]} ${searchMatch[2]}` },
    };
  }

  // 3. Yes/No prompt.
  if (YES_NO_RE.test(trimmed)) {
    const question = extractQuestionPrefix(trimmed);
    const event: PromptYesNoEvent = {
      type: 'prompt_yes_no',
      payload: { question: question || trimmed },
    };
    return event;
  }

  // 4. Numbered-options prompt.
  const opts = extractNumberedOptions(trimmed);
  if (opts) {
    const question = extractQuestionPrefix(trimmed);
    const event: PromptOptionsEvent = {
      type: 'prompt_options',
      payload: { question: question || trimmed, options: opts },
    };
    return event;
  }

  // 5. Error.
  if (ERROR_PREFIX_RE.test(trimmed) || hasRed) {
    return { type: 'error', payload: { text: trimmed.trim() } };
  }

  // 6. Default: assistant prose, with leading bullet markers stripped.
  const text = trimmed.replace(/^[\s•●◦⏺*]+/, '').trim();
  if (!text) return null;
  return { type: 'assistant_text', payload: { text } };
}
