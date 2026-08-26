/**
 * The bundle store. The claim is that a write is incremental, so what is
 * measured is how much reached the disk while bytes were still arriving — a
 * buffered write passes "a large body succeeds" just as well.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bundlePath,
  commitHandoff,
  discardHandoff,
  handoffSize,
  HandoffTooLarge,
  ORPHAN_GRACE_MS,
  removeHandoff,
  sweepOrphans,
  writeHandoff,
} from './handoff-store';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-store-'));
  dirs.push(dir);
  return dir;
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

const CHUNK = 256 * 1024;

/** A one-shot body. This runtime has no static constructor for one. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A body that reports how much had reached disk each time it was asked for more. */
function watchedBody(chunks: number, partial: string, seen: number[], onPull?: () => void) {
  let pulled = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return controller.close();
      pulled++;
      seen.push(sizeOf(partial));
      onPull?.();
      controller.enqueue(new Uint8Array(CHUNK).fill(7));
    },
  });
}

describe('writing a bundle', () => {
  test('lands on disk while the body is still arriving', async () => {
    const dir = tmpDir();
    const seen: number[] = [];
    const written = await writeHandoff(dir, 'inc', watchedBody(24, path.join(dir, 'inc.part'), seen), 64 * 1024 * 1024);

    expect(written.bytes).toBe(24 * CHUNK);
    // Buffer the body and every one of these is zero: nothing reaches the file
    // until the last chunk has been read.
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(CHUNK * 6);
    expect(seen[seen.length - 1]).toBeGreaterThan(0);
  });

  test('hashes what it wrote, without a second pass over the bytes', async () => {
    const dir = tmpDir();
    const body = Buffer.from('a sealed bundle, pretend');
    const written = await writeHandoff(dir, 'h', streamOf(new Uint8Array(body)), 1024);

    expect(written.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(written.bytes).toBe(body.length);
  });

  test('stops at the cap mid-stream and leaves nothing behind', async () => {
    const dir = tmpDir();
    const seen: number[] = [];
    const cap = CHUNK * 4;

    await expect(
      writeHandoff(dir, 'big', watchedBody(64, path.join(dir, 'big.part'), seen), cap),
    ).rejects.toBeInstanceOf(HandoffTooLarge);

    // Refused while the sender was still going, not after taking all of it.
    expect(seen.length).toBeLessThan(64);
    expect(fs.existsSync(path.join(dir, 'big.part'))).toBe(false);
  });

  test('leaves nothing behind when the body fails part-way', async () => {
    const dir = tmpDir();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection dropped'));
      },
    });

    await expect(writeHandoff(dir, 'dropped', body, 1024)).rejects.toThrow('connection dropped');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('is not the live bundle until it is committed', async () => {
    const dir = tmpDir();
    await writeHandoff(dir, 'x', streamOf(new Uint8Array([1, 2, 3])), 1024);
    expect(await handoffSize(dir, 'x')).toBeNull();

    await commitHandoff(dir, 'x');
    expect(await handoffSize(dir, 'x')).toBe(3);
    expect(fs.existsSync(bundlePath(dir, 'x'))).toBe(true);
  });

  test('discarding and removing both clear the disk', async () => {
    const dir = tmpDir();
    await writeHandoff(dir, 'a', streamOf(new Uint8Array([1])), 1024);
    await discardHandoff(dir, 'a');
    expect(fs.readdirSync(dir)).toEqual([]);

    await writeHandoff(dir, 'b', streamOf(new Uint8Array([1])), 1024);
    await commitHandoff(dir, 'b');
    await removeHandoff(dir, 'b');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('sweeping what no row claims', () => {
  test('drops abandoned files and keeps the ones still spoken for', async () => {
    const dir = tmpDir();
    for (const id of ['kept', 'orphan']) {
      await writeHandoff(dir, id, streamOf(new Uint8Array([1])), 1024);
      await commitHandoff(dir, id);
    }
    await writeHandoff(dir, 'abandoned-partial', streamOf(new Uint8Array([1])), 1024);

    const swept = await sweepOrphans(dir, new Set(['kept']), ORPHAN_GRACE_MS, Date.now() + ORPHAN_GRACE_MS * 2);

    expect(swept).toBe(2);
    expect(fs.readdirSync(dir)).toEqual(['kept.bundle']);
  });

  test('never touches an upload that is still in flight', async () => {
    const dir = tmpDir();
    let sweptDuringUpload = 0;
    const seen: number[] = [];

    // Swept from under the writer, exactly as the reaper would.
    const body = watchedBody(8, path.join(dir, 'live.part'), seen, () => {
      void sweepOrphans(dir, new Set(), ORPHAN_GRACE_MS).then((n) => {
        sweptDuringUpload += n;
      });
    });
    const written = await writeHandoff(dir, 'live', body, 64 * 1024 * 1024);

    expect(sweptDuringUpload).toBe(0);
    expect(written.bytes).toBe(8 * CHUNK);
  });
});
