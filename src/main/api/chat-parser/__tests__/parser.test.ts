// TODO(BDHLNDR-51): replace synthetic fixtures with real Claude Code session
// captures. The ticket AC calls for "5 captured samples"; we shipped 6 SYNTHETIC
// fixtures (one per v1 event type) because no real captures were available at
// implementation time. When real captures land, drop them in fixtures/ as
// NN-real-*.txt + NN-real-*.expected.json and the runner picks them up
// automatically. The classifier itself almost certainly needs tightening once
// real fixtures arrive — particularly the assistant_text and tool_call
// patterns, which were calibrated against Claude Code's typical render style
// but not against actual byte-for-byte output.
//
// Run with: bun test src/main/api/chat-parser
// (no test runner is configured in package.json; bun has bun:test built-in.)

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

function loadFixtures(): Fixture[] {
  const entries = fs.readdirSync(FIXTURES_DIR);
  const txtFiles = entries.filter((f) => f.endsWith('.txt')).sort();
  return txtFiles.map((txt) => {
    const base = txt.replace(/\.txt$/, '');
    const input = fs.readFileSync(path.join(FIXTURES_DIR, txt), 'utf8');
    const expectedRaw = fs.readFileSync(
      path.join(FIXTURES_DIR, `${base}.expected.json`),
      'utf8'
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
    test(fx.name, () => {
      const parser = new ChatParser();
      const events = [...parser.parse(fx.input), ...parser.flush()];
      expect(events).toEqual(fx.expected);
    });
  }
});

describe('ChatParser streaming behaviour', () => {
  test('buffers incomplete trailing lines across chunks', () => {
    const parser = new ChatParser();
    const a = parser.parse('Hello, this is the start of ');
    expect(a).toEqual([]);
    const b = parser.parse('a sentence.\n');
    expect(b).toEqual([
      {
        type: 'assistant_text',
        payload: { text: 'Hello, this is the start of a sentence.' },
      },
    ]);
  });

  test('flush emits a trailing line with no newline', () => {
    const parser = new ChatParser();
    parser.parse('Half a line ');
    const flushed = parser.flush();
    expect(flushed).toEqual([
      { type: 'assistant_text', payload: { text: 'Half a line' } },
    ]);
    // Flushing twice is a no-op.
    expect(parser.flush()).toEqual([]);
  });

  test('handles CRLF and bare CR line terminators', () => {
    const parser = new ChatParser();
    const events = parser.parse('one\r\ntwo\rthree\n');
    expect(events.map((e) => (e as any).payload.text)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  test('strips SGR ANSI but preserves the text payload', () => {
    const parser = new ChatParser();
    const ESC = '\x1b';
    const events = parser.parse(`${ESC}[1mBold prose${ESC}[0m\n`);
    expect(events).toEqual([
      { type: 'assistant_text', payload: { text: 'Bold prose' } },
    ]);
  });

  test('red SGR classifies as error even without an Error: prefix', () => {
    const parser = new ChatParser();
    const ESC = '\x1b';
    const events = parser.parse(`${ESC}[31mSomething went wrong${ESC}[0m\n`);
    expect(events).toEqual([
      { type: 'error', payload: { text: 'Something went wrong' } },
    ]);
  });

  test('ignores box-drawing / whitespace-only noise lines', () => {
    const parser = new ChatParser();
    const events = parser.parse('───────────────\n   \n');
    expect(events).toEqual([]);
  });
});
