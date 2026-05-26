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

  test('does NOT drop real user input "❯ run tests"', async () => {
    const events = await runFixture('❯ run tests\n');
    expect(events).toEqual([
      { type: 'response', payload: { text: 'run tests' } },
    ]);
  });
});

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
  });
});
