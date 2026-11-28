import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import * as path from 'path';

const AGENT = path.join(__dirname, '../../../../resources/crew-agent/crew-agent.mjs');
const { relayData } = await import(AGENT);

function fakeConn() {
  return Object.assign(new EventEmitter(), {
    paused: false,
    pause() { this.paused = true; },
    resume() { this.paused = false; },
  });
}

function fakeOut(full: boolean[]) {
  const lines: string[] = [];
  return Object.assign(new EventEmitter(), { lines, write: (line: string) => (lines.push(line), !(full.shift() ?? false)) });
}

describe('crew-agent relaying a socket to stdout', () => {
  test('a full stdout pauses the socket until it drains, and nothing is dropped', () => {
    const conn = fakeConn();
    const out = fakeOut([true]);
    relayData(conn, 7, out);
    conn.emit('data', Buffer.from('first'));
    expect(conn.paused).toBe(true);
    out.emit('drain');
    expect(conn.paused).toBe(false);
    conn.emit('data', Buffer.from('second'));
    expect(conn.paused).toBe(false);
    expect(out.lines.map((l) => JSON.parse(l))).toEqual([
      { t: 'data', conn: 7, b64: Buffer.from('first').toString('base64') },
      { t: 'data', conn: 7, b64: Buffer.from('second').toString('base64') },
    ]);
  });
});
