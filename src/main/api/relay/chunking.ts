/**
 * Splitting oversized terminal payloads into transport-sized frames.
 *
 * Scrollback replay (`ptyManager.getSerializedBuffer`) can return a very large
 * string — the headless terminal keeps 20k lines — and it was previously sealed
 * into a SINGLE frame. After base64 of AES-GCM that is ~1.37x the source, so a
 * busy session could put multi-megabyte messages on the wire and left the relay
 * unable to set any sane `maxPayloadLength`.
 *
 * Splitting is safe for both consumers: xterm.js keeps parser state across
 * `write()` calls, so an escape sequence straddling a chunk boundary is still
 * interpreted correctly, and the frames are sealed and sent in order under a
 * monotonic counter the receiver already enforces.
 */

/**
 * Source characters per chunk. Terminal output is overwhelmingly ASCII, so this
 * is ~64 KiB of source → ~88 KB of base64 ciphertext per frame.
 */
export const MAX_CHUNK_CHARS = 64 * 1024;

/**
 * Split `text` into chunks of at most `maxChars`, never splitting a surrogate
 * pair (which would corrupt the character and, once sealed, be undetectable
 * until it reached the renderer).
 *
 * An empty input yields an empty array — callers should send nothing rather
 * than an empty frame.
 */
export function chunkText(text: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    // Don't cut between a high and low surrogate; retreat one unit so the pair
    // travels together in the next chunk.
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
