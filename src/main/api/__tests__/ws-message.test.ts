/**
 * Turning a websocket payload into text.
 *
 * This exists because `data.toString()` — the idiom it replaced — is correct
 * for only one of the three shapes `RawData` can take. It decodes the pairing
 * handshake and every post-auth frame, so it reads untrusted network input,
 * and the two shapes the old code got wrong are the ones with no natural
 * coverage: nothing in ordinary local use produces a fragmented frame or an
 * ArrayBuffer, which is how the bug survived.
 */
import { describe, expect, test } from 'bun:test';
import type { RawData } from 'ws';
import { messageText } from '../ws-message';

const FRAME = JSON.stringify({ type: 'auth', token: 'abc', nested: { n: 1 } });

/** Split a payload the way a fragmented frame arrives. */
function fragmentsOf(buf: Buffer, cut: number): RawData {
  return [buf.subarray(0, cut), buf.subarray(cut)] as unknown as RawData;
}

describe('messageText', () => {
  test('decodes a Buffer — the shape that always worked', () => {
    expect(messageText(Buffer.from(FRAME, 'utf8'))).toBe(FRAME);
  });

  /**
   * A fragmented frame arrives as an array of Buffers, and Array.toString()
   * joins with commas — so a payload split mid-token gained a stray comma at
   * the seam and stopped parsing.
   */
  test('rejoins a fragmented frame without inventing a separator', () => {
    const whole = Buffer.from(FRAME, 'utf8');
    const cut = Math.floor(whole.length / 2);

    expect(messageText(fragmentsOf(whole, cut))).toBe(FRAME);
    expect(JSON.parse(messageText(fragmentsOf(whole, cut)))).toEqual(JSON.parse(FRAME));
    // What the replaced idiom produced from the same input.
    expect([whole.subarray(0, cut), whole.subarray(cut)].toString()).not.toBe(FRAME);
  });

  /** An ArrayBuffer stringifies to '[object ArrayBuffer]' — the message is
   *  lost outright rather than mangled. */
  test('decodes an ArrayBuffer instead of stringifying the object', () => {
    const bytes = new TextEncoder().encode(FRAME);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    expect(messageText(ab)).toBe(FRAME);
    expect(String(ab)).toBe('[object ArrayBuffer]');
  });

  /** Concatenating bytes before decoding, rather than decoding each fragment,
   *  is what keeps a character split across the seam intact. */
  test('survives a multi-byte character split across fragments', () => {
    const text = 'auth: café — ☕';
    const whole = Buffer.from(text, 'utf8');
    const cut = whole.indexOf(Buffer.from('é', 'utf8')) + 1;

    expect(messageText(fragmentsOf(whole, cut))).toBe(text);
  });

  test('an empty payload is empty text, not a throw', () => {
    expect(messageText(Buffer.alloc(0))).toBe('');
    expect(messageText([] as unknown as RawData)).toBe('');
  });
});
