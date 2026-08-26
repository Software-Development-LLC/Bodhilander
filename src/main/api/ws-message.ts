import type { RawData } from 'ws';

/**
 * A websocket payload as text.
 *
 * `RawData` is `Buffer | ArrayBuffer | Buffer[]`, and only the first of those
 * has a `toString()` that yields the message: an ArrayBuffer stringifies to
 * '[object ArrayBuffer]' and a fragment array to comma-joined halves. Which
 * arrives depends on `binaryType` and on whether the frame was fragmented, so
 * the common `data.toString()` is right for the case that usually happens
 * rather than for the type.
 */
export function messageText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
