/**
 * ChatParser tests (BDHLNDR-72 — terminal-emulator rewrite).
 *
 * The parser now wraps a headless xterm Terminal. Tests construct a parser
 * with a `settleMs: 0` debounce (or rely on `flush()` for an immediate
 * harvest) so they don't wait on real-time timers.
 *
 * Synthetic fixtures live next to this file; each `<name>.txt` pairs with
 * `<name>.expected.json`. Real-capture fixtures pulled from production
 * sessions are kept under `fixtures/real-*` and may overwrite their
 * `.expected.json` via a snapshot-update flow when needed (intentionally
 * NOT automatic — bumping the snapshot requires a code change).
 *
 * FIXTURES USE CRLF, DELIBERATELY. They are fed to a terminal emulator, so
 * they have to look like a PTY stream. LF alone moves the cursor down without
 * returning it to column 0 — only CR does that — so a bare-LF fixture renders
 * each successive line indented by the length of the one before it. That is
 * not what any real terminal produces, and it silently changes classification:
 * the user-input `> ` rule is anchored at line start, so an indented prompt
 * falls through to assistant prose. Do not "normalise" these to LF; the
 * fixtures directory carries a .gitattributes marking them -text to stop a
 * core.autocrlf checkout from doing it for you.
 *
 * Run with: bun test src/main/api/chat-parser
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { ChatParser } from '../parser';
import type { ChatEvent } from '../types';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

interface Fixture {
  name: string;
  input: string;
  expected: ChatEvent[];
}

/**
 * Run a single input string through the parser and return all events that
 * came out (via the callback, plus anything flushed at the end). The harvest
 * is debounced in real use; for tests we set `settleMs: 0` so the harvest
 * fires on the next tick, and we also explicitly flush() to capture the
 * cursor row at the end.
 */
async function runFixture(input: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  const parser = new ChatParser((evs) => events.push(...evs), { settleMs: 0 });
  await parser.parse(input);
  // Let the debounced harvest fire (settleMs: 0 → next tick).
  await new Promise((r) => setTimeout(r, 5));
  parser.flush();
  parser.dispose();
  return events;
}

function loadFixtures(): Fixture[] {
  const entries = fs.readdirSync(FIXTURES_DIR);
  const txtFiles = entries.filter((f) => f.endsWith('.txt')).sort();
  return txtFiles.map((txt) => {
    const base = txt.replace(/\.txt$/, '');
    const input = fs.readFileSync(path.join(FIXTURES_DIR, txt), 'utf8');
    const expectedRaw = fs.readFileSync(
      path.join(FIXTURES_DIR, `${base}.expected.json`),
      'utf8',
    );
    return {
      name: base,
      input,
      expected: JSON.parse(expectedRaw) as ChatEvent[],
    };
  });
}

/**
 * Self-enforce the CRLF invariant the fixtures above depend on.
 *
 * .gitattributes stops a `core.autocrlf` checkout from rewriting these, but it
 * cannot stop an editor — or a contributor bypassing git — from re-saving one
 * with bare LF. That silently reintroduces the exact bug this corpus already
 * hit once: a bare LF leaves the cursor where it was, so the next line renders
 * indented by the length of the previous one and stops matching any
 * line-start-anchored rule.
 *
 * Scoped to the synthetic *.txt fixtures. The real-* captures are raw PTY
 * recordings whose byte stream is whatever the terminal actually emitted
 * (including bare line feeds between spinner frames), so the same rule does
 * not apply to them.
 */
describe('fixture line endings', () => {
  test('every synthetic fixture uses CRLF, never a bare LF', () => {
    const offenders: string[] = [];

    for (const txt of fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.txt')).sort()) {
      // latin1 is a byte-for-byte decode, so a CR survives as '\r'.
      const segments = fs.readFileSync(path.join(FIXTURES_DIR, txt), 'latin1').split('\n');
      segments.forEach((segment, idx) => {
        // The tail after the final LF is not a line — nothing to terminate.
        if (idx === segments.length - 1) return;
        if (!segment.endsWith('\r')) offenders.push(`${txt}:${idx + 1}`);
      });
    }

    // Any entry here names the file:line that needs its CR put back.
    expect(offenders).toEqual([]);
  });
});

describe('ChatParser snapshot fixtures', () => {
  const fixtures = loadFixtures();
  expect(fixtures.length).toBeGreaterThanOrEqual(5);

  for (const fx of fixtures) {
    test(fx.name, async () => {
      const events = await runFixture(fx.input);
      expect(events).toEqual(fx.expected);
    });
  }
});

describe('ChatParser streaming + terminal-emulator behaviour', () => {
  test('joins chunks across a logical line into one event', async () => {
    const events: ChatEvent[] = [];
    const parser = new ChatParser((e) => events.push(...e), { settleMs: 0 });
    await parser.parse('Hello, this is the start of ');
    await parser.parse('a sentence.\n');
    await new Promise((r) => setTimeout(r, 5));
    parser.flush();
    parser.dispose();
    expect(events).toEqual([
      {
        type: 'assistant_text',
        payload: { text: 'Hello, this is the start of a sentence.' },
      },
    ]);
  });

  test('flush emits a trailing line with no newline', async () => {
    const events: ChatEvent[] = [];
    const parser = new ChatParser((e) => events.push(...e), { settleMs: 0 });
    await parser.parse('Half a line');
    parser.flush();
    parser.dispose();
    expect(events).toEqual([
      { type: 'assistant_text', payload: { text: 'Half a line' } },
    ]);
  });

  test('bare CR rewrites the current line (does NOT commit it)', async () => {
    // This is the headline BDHLNDR-72 fix. The old parser treated `\r` as a
    // line break and emitted "one", "two", "three". xterm treats `\r` as
    // "cursor to col 0", so writing "two" then "\r" then "three" leaves the
    // row reading "three" (with "wo" overwritten). Final committed lines:
    // "one" on row 0, "three" on row 1.
    const events = await runFixture('one\r\ntwo\rthree\n');
    expect(events.map((e) => (e as { payload: { text: string } }).payload.text)).toEqual([
      'one',
      'three',
    ]);
  });

  test('strips SGR ANSI but preserves the text payload', async () => {
    const ESC = '\x1b';
    const events = await runFixture(`${ESC}[1mBold prose${ESC}[0m\n`);
    expect(events).toEqual([
      { type: 'assistant_text', payload: { text: 'Bold prose' } },
    ]);
  });

  test('red SGR classifies as error even without an Error: prefix', async () => {
    const ESC = '\x1b';
    const events = await runFixture(`${ESC}[31mSomething went wrong${ESC}[0m\n`);
    expect(events).toEqual([
      { type: 'error', payload: { text: 'Something went wrong' } },
    ]);
  });

  test('ignores box-drawing / whitespace-only noise lines', async () => {
    const events = await runFixture('───────────────\n   \n');
    expect(events).toEqual([]);
  });

  test('SPINNER SUPPRESSION: CR-only frames produce zero events', async () => {
    // Synthesised spinner: 100 frames of `\r✶thinking\r✻thinking...` style
    // updates, each rewriting the same row, then a final `\n` commits an
    // empty row. The headline regression the rewrite exists to fix.
    let stream = '';
    const glyphs = ['✶', '✻', '✽', '✢', '·', '*'];
    for (let i = 0; i < 100; i++) {
      stream += `\r${glyphs[i % glyphs.length]} thinking…`;
    }
    stream += '\r\n';
    const events = await runFixture(stream);
    expect(events).toEqual([]);
  });
});

describe('ChatParser classifier tuning (BDHLNDR-73)', () => {
  test('classifies "Reading N file…" as a Read tool call', async () => {
    const events = await runFixture('Reading 1 file… (ctrl+o to expand)\n');
    expect(events).toEqual([
      { type: 'tool_call', payload: { tool: 'Read', argsBrief: '1 file' } },
    ]);
  });

  test('classifies "Read N file (ctrl+o to expand)" as a Read tool call', async () => {
    const events = await runFixture('Read 1 file (ctrl+o to expand)\n');
    expect(events).toEqual([
      { type: 'tool_call', payload: { tool: 'Read', argsBrief: '1 file' } },
    ]);
  });

  test('classifies "Searching for N pattern…" as a Grep tool call', async () => {
    const events = await runFixture('Searching for 1 pattern… (ctrl+o to expand)\n');
    expect(events).toEqual([
      { type: 'tool_call', payload: { tool: 'Grep', argsBrief: '1 pattern' } },
    ]);
  });

  test('classifies "Searched for N pattern" as a Grep tool call', async () => {
    const events = await runFixture('Searched for 1 pattern (ctrl+o to expand)\n');
    expect(events).toEqual([
      { type: 'tool_call', payload: { tool: 'Grep', argsBrief: '1 pattern' } },
    ]);
  });

  test('drops decorative tool-result header "──Read package.json"', async () => {
    const events = await runFixture('──Read package.json\n');
    expect(events).toEqual([]);
  });

  test('drops decorative tool-result header with quoted arg', async () => {
    const events = await runFixture('──── "src/main/api/**/*"\n');
    expect(events).toEqual([]);
  });

  test('drops bare timing "(3s)"', async () => {
    const events = await runFixture('(3s)\n');
    expect(events).toEqual([]);
  });

  test('drops bare timing "(1m 30s)"', async () => {
    const events = await runFixture('(1m 30s)\n');
    expect(events).toEqual([]);
  });

  test('drops lone prompt indicator "❯"', async () => {
    const events = await runFixture('❯\n');
    expect(events).toEqual([]);
  });

  test('drops lone prompt indicator ">"', async () => {
    const events = await runFixture('>\n');
    expect(events).toEqual([]);
  });

  test('drops "Shell details" header with long trailing decoration', async () => {
    const events = await runFixture(
      'Shell details' + '─'.repeat(75) + '\n',
    );
    expect(events).toEqual([]);
  });

  test('keeps tree-render lines with short trailing padding', async () => {
    // Real content — a few trailing dashes shouldn't trigger the filter.
    const events = await runFixture(
      '├── parser.ts          ← The new state machine\n',
    );
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('assistant_text');
  });

  test('drops spinner + present-progressive verb + ellipsis with no trailing timing', async () => {
    // Bare `· Rewriting…` (no `(Ns · ↓tokens)` tail) is still a spinner
    // status — earlier observations showed these leak through. Narrow shape:
    // leading spinner glyph as the only leader, single capitalized -ing verb,
    // trailing ellipsis.
    const events = await runFixture('· Rewriting…\n');
    expect(events).toEqual([]);
  });

  test('drops "✶ Pondering…" (spinner + verb + ellipsis)', async () => {
    const events = await runFixture('✶ Pondering…\n');
    expect(events).toEqual([]);
  });

  test('drops novel-verb spinner statuses by shape (glyph + word + ellipsis)', async () => {
    // Claude rotates verbs continuously; the verb-alternation list will
    // always lag. A spinner glyph + short text + ellipsis is the durable
    // shape signal. Tested with two synthesized verbs not in the alternation.
    const events1 = await runFixture('✶ Distilling…\n');
    expect(events1).toEqual([]);
    const events2 = await runFixture('✻ Crystallizing the response…\n');
    expect(events2).toEqual([]);
  });

  test('does NOT drop prose "Rewriting the parser for clarity"', async () => {
    // No leading spinner glyph, no ellipsis — real prose, must survive.
    const events = await runFixture('Rewriting the parser for clarity\n');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('assistant_text');
  });

  test('does NOT drop real user input "❯ run tests"', async () => {
    const events = await runFixture('❯ run tests\n');
    expect(events).toEqual([
      { type: 'response', payload: { text: 'run tests' } },
    ]);
  });
});

describe('ChatParser classifier v3 (BDHLNDR-75)', () => {
  test('drops "※ Churned for 37s" — ※ glyph used by Claude Code', async () => {
    const events = await runFixture('※ Churned for 37s\n');
    expect(events).toEqual([]);
  });

  test('drops "※ recap: ..." status lines', async () => {
    const events = await runFixture('※ recap: doing a thing\n');
    expect(events).toEqual([]);
  });

  test('drops bare ※ glyphs (glyph-only line)', async () => {
    const events = await runFixture('※\n');
    expect(events).toEqual([]);
  });

  test('drops "※ Distilling…" by shape (※ in spinner-shape charset)', async () => {
    const events = await runFixture('※ Distilling…\n');
    expect(events).toEqual([]);
  });

  test('dedupe holds across >16 interleaved unique events', async () => {
    // Synthesise: 25 unique lines, then a repeat of the FIRST one. The old
    // 16-entry ring would have already evicted "line 0" by event #25, so
    // the repeat would slip through. New dedupe should remember it.
    let input = '';
    for (let i = 0; i < 25; i++) input += `unique line ${i}\n`;
    input += 'unique line 0\n'; // duplicate of the very first line
    const events = await runFixture(input);
    const texts = events
      .filter((e) => e.type === 'assistant_text')
      .map((e) => (e as { payload: { text: string } }).payload.text);
    // Should see each unique line exactly once — 25 events, not 26.
    expect(texts.length).toBe(25);
    expect(texts.filter((t) => t === 'unique line 0').length).toBe(1);
  });
});

describe('ChatParser wrap-space recovery (BDHLNDR-73 #40)', () => {
  /** Run with a narrow terminal so wraps trigger on small inputs. */
  async function runNarrow(input: string, cols = 10): Promise<ChatEvent[]> {
    const events: ChatEvent[] = [];
    const parser = new ChatParser((evs) => events.push(...evs), {
      settleMs: 0,
      cols,
    });
    await parser.parse(input);
    await new Promise((r) => setTimeout(r, 5));
    parser.flush();
    parser.dispose();
    return events;
  }

  test('preserves space at wrap boundary (Claude wrote "memory usage")', async () => {
    // 10-col terminal. "memory usage" is 12 chars — wraps between "memory" + space.
    // Without recovery: "memoryusage". With recovery: "memory usage".
    const events = await runNarrow('memory usage\n', 10);
    expect(events).toEqual([
      { type: 'assistant_text', payload: { text: 'memory usage' } },
    ]);
  });

  test('preserves space at wrap boundary (longer phrase)', async () => {
    // "Slack and Discord" — 17 chars, wraps mid-phrase. Expect spaces preserved.
    const events = await runNarrow('Slack and Discord\n', 10);
    expect(events).toEqual([
      { type: 'assistant_text', payload: { text: 'Slack and Discord' } },
    ]);
  });

  test('does NOT insert a space mid-token when no original space existed', async () => {
    // A 15-char single identifier (no spaces). 10-col wrap. Must NOT become "abc...def xyz".
    const ident = 'abcdefghijklmno';
    const events = await runNarrow(ident + '\n', 10);
    expect(events).toEqual([
      { type: 'assistant_text', payload: { text: ident } },
    ]);
  });

  test('preserves Claude-Code cursor-positioned text wider than 120 cols', async () => {
    // Real-corpus pattern: Claude paints with absolute cursor positioning
    // (`ESC[NG` = cursor to col N). The captured corpus contains instructions
    // up to col 197+. With TERM_COLS=120, `ESC[121G` clamps to col 120 and
    // xterm autowraps, fusing "memory" + "usage" into "memoryusage".
    //
    // Synthesises the exact corpus byte pattern around "memory usage".
    const ESC = '\x1b';
    const input =
      `${ESC}[110Gand${ESC}[114Gmemory${ESC}[121Gusage${ESC}[127Gis\r\n`;
    // Use default cols (no override) — this is the production scenario.
    const events: ChatEvent[] = [];
    const parser = new ChatParser((e) => events.push(...e), { settleMs: 0 });
    await parser.parse(input);
    await new Promise((r) => setTimeout(r, 5));
    parser.flush();
    parser.dispose();
    // The full logical text should preserve word boundaries.
    const allText = events
      .filter((e) => e.type === 'assistant_text')
      .map((e) => (e as { payload: { text: string } }).payload.text)
      .join(' ');
    expect(allText).toContain('memory usage');
  });

  test('preserves space when wrap falls between word and punctuation', async () => {
    // "concerns (windows," — space + paren is the natural break.
    const events = await runNarrow('concerns (windows)\n', 10);
    expect(events).toEqual([
      { type: 'assistant_text', payload: { text: 'concerns (windows)' } },
    ]);
  });
});

/**
 * Ceiling for the real-corpus test (#233).
 *
 * bun's default is 5000ms, and this test overran it in the full-repo run under
 * coverage instrumentation — `5016.05ms`, i.e. it did not assert wrong, it ran
 * out of clock. Measured: ~2s wall in isolation under `--coverage` with every
 * core saturated, so the default left only about 2x headroom, which an 88-file
 * parallel run consumes.
 *
 * Raised rather than making the test cheaper on purpose. It parses a 340KB real
 * PTY capture, and the size of that corpus is the point of the regression —
 * trimming it to fit a timeout would quietly weaken the only test that has ever
 * caught this class of parser bug. This number is a backstop against a hang,
 * not a performance budget: if it is ever reached, something is genuinely wrong.
 */
const REAL_CORPUS_TIMEOUT_MS = 30_000;

describe('ChatParser real-corpus regression (BDHLNDR-72)', () => {
  test('5-min real Claude session captures: extracts real content, suppresses noise', async () => {
    // Real PTY capture from one of @Will Long's Bodhilander sessions on
    // 2026-05-25. 340KB raw containing: 3 paragraphs of prose about Electron
    // apps, two tool calls (Read + Glob), a bash error, and several typed
    // prompts — plus ~20,000 spinner-frame line-feeds.
    //
    // The old parser produced 1572 events from this stream, longest payload
    // a single character. This regression locks in that the rewrite:
    //  - extracts substantive content (>=50 events, but capped well below
    //    the old garbage flood)
    //  - finds the Electron-app prose explicitly
    //  - classifies at least one `response` (user input echo) correctly
    const raw = fs.readFileSync(
      path.join(FIXTURES_DIR, 'real-corpus-bdhlndr-72.raw'),
      'utf8',
    );
    const events: ChatEvent[] = [];
    const parser = new ChatParser((e) => events.push(...e), { settleMs: 0 });
    const CHUNK = 4096;
    for (let i = 0; i < raw.length; i += CHUNK) {
      await parser.parse(raw.slice(i, i + CHUNK));
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 10));
    parser.flush();
    parser.dispose();

    // Sanity bounds — nowhere near the old 1572-event flood, but more than
    // a handful of substantive lines.
    expect(events.length).toBeGreaterThan(50);
    expect(events.length).toBeLessThan(400);

    // Real prose substring from one of the captured responses.
    const hasElectronProse = events.some(
      (e) =>
        e.type === 'assistant_text' && e.payload.text.includes('Electron app'),
    );
    expect(hasElectronProse).toBe(true);

    // At least one user-input echo correctly classified.
    expect(events.some((e) => e.type === 'response')).toBe(true);

    // BDHLNDR-73: real-corpus tool-call recovery — at least one of the
    // Read/Glob tool calls in the corpus should now classify correctly.
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);

    // BDHLNDR-73: leaker regressions — none of these chrome patterns
    // should survive classification.
    const text = (e: ChatEvent) =>
      e.type === 'assistant_text' || e.type === 'error' || e.type === 'response'
        ? e.payload.text
        : '';
    const leakers = events
      .map(text)
      .filter((t) => {
        const s = t.trim();
        if (!s) return false;
        // Lone prompt indicator
        if (/^[>❯]$/.test(s)) return true;
        // Bare timing
        if (/^\(\s*\d+\s*[smh]\s*(?:\d+\s*[smh]\s*)?\)$/i.test(s)) return true;
        // Decorative header (line starts with 2+ box-drawing dashes)
        if (/^[─━]{2,}\s*\S/.test(s)) return true;
        return false;
      });
    expect(leakers).toEqual([]);

    // BDHLNDR-73 #40: wrap-space recovery — these three corrupted strings
    // were present in the v1 (TERM_COLS=120) output of the real corpus.
    // After bumping TERM_COLS to cover Claude's cursor-positioning range,
    // they should be repaired.
    const allText = events
      .map(text)
      .join('\n');
    expect(allText).toContain('memory usage');
    expect(allText).toContain('concerns (windows');
    expect(allText).toContain('Slack, and Figma');
  }, REAL_CORPUS_TIMEOUT_MS);
});
