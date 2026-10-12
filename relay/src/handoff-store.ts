/**
 * Sealed bundles on disk, named by the row that claims them. Nothing here
 * reads a whole one: a write holds the chunk in hand and nothing else, which
 * is what keeps memory independent of how much state a machine carries.
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * How long a file with no row gets before it is treated as abandoned. Long
 * enough that an upload still streaming is never mistaken for one.
 */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

const BUNDLE_SUFFIX = '.bundle';
const PARTIAL_SUFFIX = '.part';

/** The id a store filename carries, or null when the file is not one of ours. */
function idFromFilename(name: string): string | null {
  for (const suffix of [BUNDLE_SUFFIX, PARTIAL_SUFFIX]) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return null;
}

/** Raised mid-stream, so an oversized upload stops rather than completing. */
export class HandoffTooLarge extends Error {
  override name = 'HandoffTooLarge';
}

export interface WrittenHandoff {
  bytes: number;
  sha256: string;
}

export function bundlePath(dir: string, id: string): string {
  return path.join(dir, `${id}${BUNDLE_SUFFIX}`);
}

function partialPath(dir: string, id: string): string {
  return path.join(dir, `${id}${PARTIAL_SUFFIX}`);
}

/**
 * Stream `body` into the store, hashing and counting as it lands. A write that
 * ends any way but cleanly — over the cap, a dropped connection — leaves no
 * partial behind, and the bytes are not the live bundle until `commitHandoff`.
 */
export async function writeHandoff(
  dir: string,
  id: string,
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<WrittenHandoff> {
  await mkdir(dir, { recursive: true });
  const partial = partialPath(dir, id);
  const hash = createHash('sha256');
  const handle = await open(partial, 'w');
  const reader = body.getReader();
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new HandoffTooLarge();
      hash.update(value);
      await handle.write(value);
    }
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(partial).catch(() => {});
    void reader.cancel().catch(() => {});
    throw err;
  }

  return { bytes, sha256: hash.digest('hex') };
}

/** Promote a completed upload to the live bundle for `id`. */
export async function commitHandoff(dir: string, id: string): Promise<void> {
  await rename(partialPath(dir, id), bundlePath(dir, id));
}

export async function discardHandoff(dir: string, id: string): Promise<void> {
  await unlink(partialPath(dir, id)).catch(() => {});
}

export async function removeHandoff(dir: string, id: string): Promise<void> {
  await unlink(bundlePath(dir, id)).catch(() => {});
}

/** Bytes on disk for a stored bundle, or null when there is no file. */
export async function handoffSize(dir: string, id: string): Promise<number | null> {
  try {
    return (await stat(bundlePath(dir, id))).size;
  } catch {
    return null;
  }
}

/**
 * Drop expired bundles, rows and files together. Kept in one place because the
 * two must not diverge: a row without a file serves a 404, and a file without
 * a row is disk nobody will ever reclaim.
 */
export async function purgeExpiredHandoffs(
  repos: { purgeExpiredHandoffBundles(): string[] },
  dir: string,
): Promise<number> {
  const ids = repos.purgeExpiredHandoffBundles();
  for (const id of ids) await removeHandoff(dir, id);
  return ids.length;
}

/**
 * Drop files no row claims. A crash between writing one and recording it
 * strands a file, and an upload in flight has no row yet — so only files
 * untouched for `graceMs` are considered abandoned.
 */
export async function sweepOrphans(
  dir: string,
  liveIds: Set<string>,
  graceMs: number,
  now: number = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of names) {
    const id = idFromFilename(name);
    if (id === null || liveIds.has(id)) continue;

    const full = path.join(dir, name);
    try {
      if (now - (await stat(full)).mtimeMs < graceMs) continue;
      await unlink(full);
      removed++;
    } catch {
      continue;
    }
  }
  return removed;
}
