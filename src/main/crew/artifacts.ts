/**
 * Crew's pinned Windows artifacts: `versions.json`, and the rootfs download
 * through the Hub's `artifact` frame. Integrity comes only from the SHA-256
 * shipped in the app; the Hub sends a URL and never a hash.
 */
import { createHash, randomUUID } from 'crypto';
import type { ArtifactFrame, RefusedFrame } from './protocol';

export const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
export const ARTIFACT_TIMEOUT_MS = 30_000;
export const MAX_URLS_PER_DOWNLOAD = 10;
const SHA256 = /^[0-9a-f]{64}$/;

export const IMAGE_UNAVAILABLE = "Repair needs Crew's Linux image, which this PC downloads from Crew. Connect to Crew and try again";
export const IMAGE_MISMATCH = "The downloaded image didn't match. Nothing was installed";
export const IMAGE_DOWNLOAD_FAILED = "Crew's Linux image didn't download. Nothing was installed";

export interface CrewVersions {
  rootfs: { name: string; sha256: string };
  node: { version: string; file: string; sha256: string };
  claude: { version: string };
  crewAgent: { version: string };
  apt: { bubblewrap: string; socat: string };
}

export function validArtifactName(name: string): boolean {
  return ARTIFACT_NAME.test(name) && !name.split('/').includes('..');
}

/** A placeholder, or anything but 64 lowercase hex digits, can never match a download. */
export function isPinnedSha(sha: string): boolean {
  return SHA256.test(sha);
}

export function parseVersions(raw: string): CrewVersions {
  const v = JSON.parse(raw) as CrewVersions;
  const strings = [v.rootfs?.name, v.rootfs?.sha256, v.node?.version, v.node?.file, v.node?.sha256, v.claude?.version, v.crewAgent?.version, v.apt?.bubblewrap, v.apt?.socat];
  if (strings.some((s) => typeof s !== 'string' || s === '')) throw new Error('versions.json is missing a field');
  if (!validArtifactName(v.rootfs.name)) throw new Error(`versions.json names an invalid blob: ${v.rootfs.name}`);
  return v;
}

export type ArtifactFailure = 'unavailable' | 'mismatch' | 'download';

export class ArtifactError extends Error {
  constructor(readonly failure: ArtifactFailure, message: string) {
    super(message);
  }
}

export type ArtifactAnswer = { url: string; expiresAt: number } | { refused: string } | null;

/** The part of HubClient an artifact request needs. */
export interface ArtifactHub {
  sendArtifactRequest(id: string, name: string): boolean;
  on(event: 'artifact', cb: (frame: ArtifactFrame) => void): unknown;
  on(event: 'refused', cb: (frame: RefusedFrame) => void): unknown;
  off(event: 'artifact' | 'refused', cb: (...args: never[]) => void): unknown;
}

export interface ArtifactTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

/** Null on an unlinked or offline PC, or with no answer in time. */
export function requestArtifactUrl(hub: ArtifactHub, name: string, timers: ArtifactTimers = globalThis, timeoutMs = ARTIFACT_TIMEOUT_MS): Promise<ArtifactAnswer> {
  const id = randomUUID();
  return new Promise((resolve) => {
    let done = false;
    const settle = (answer: ArtifactAnswer) => {
      if (done) return;
      done = true;
      hub.off('artifact', onArtifact as never);
      hub.off('refused', onRefused as never);
      timers.clearTimeout(timer);
      resolve(answer);
    };
    const onArtifact = (frame: ArtifactFrame) => {
      if (frame.id !== id) return;
      if (frame.name !== name || !frame.url.startsWith('https://')) return settle({ refused: 'malformed' });
      settle({ url: frame.url, expiresAt: frame.expiresAt });
    };
    const onRefused = (frame: RefusedFrame) => {
      if (frame.id === id) settle({ refused: frame.reason });
    };
    hub.on('artifact', onArtifact);
    hub.on('refused', onRefused);
    const timer = timers.setTimeout(() => settle(null), timeoutMs);
    if (!hub.sendArtifactRequest(id, name)) settle(null);
  });
}

export interface HttpAnswer {
  status: number;
  body: AsyncIterable<Uint8Array>;
}

export interface DownloadFs {
  /** Bytes already on disk, or null when the file is absent. */
  size(file: string): number | null;
  read(file: string): AsyncIterable<Uint8Array>;
  append(file: string, chunk: Uint8Array): void;
  truncate(file: string): void;
  remove(file: string): void;
}

export interface DownloadDeps {
  request(name: string): Promise<ArtifactAnswer>;
  /** A GET of the URL, with `Range: bytes=<from>-` when from > 0. */
  get(url: string, from: number): Promise<HttpAnswer>;
  fs: DownloadFs;
  now(): number;
  onProgress?(received: number): void;
}

export interface DownloadSpec {
  name: string;
  sha256: string;
  file: string;
}

/** The URL's SAS is in memory only, so it is never logged or kept. */
async function nextUrl(deps: DownloadDeps, name: string, used: number): Promise<{ url: string; expiresAt: number }> {
  if (used >= MAX_URLS_PER_DOWNLOAD) throw new ArtifactError('download', IMAGE_DOWNLOAD_FAILED);
  const answer = await deps.request(name);
  if (answer === null || 'refused' in answer) throw new ArtifactError('unavailable', IMAGE_UNAVAILABLE);
  return answer;
}

/**
 * Streams the blob to `file` with an incremental SHA-256. A partial left by an
 * earlier attempt at the same blob is resumed with `Range` and re-hashed.
 * A mismatch deletes the file.
 */
export async function downloadArtifact(deps: DownloadDeps, spec: DownloadSpec): Promise<string> {
  if (!validArtifactName(spec.name) || !isPinnedSha(spec.sha256)) throw new ArtifactError('unavailable', IMAGE_UNAVAILABLE);
  let hash = createHash('sha256');
  let received = 0;
  if ((deps.fs.size(spec.file) ?? 0) > 0) {
    for await (const chunk of deps.fs.read(spec.file)) {
      hash.update(chunk);
      received += chunk.length;
    }
  }
  let urls = 0;
  let current = await nextUrl(deps, spec.name, urls++);
  for (;;) {
    if (deps.now() >= current.expiresAt) {
      current = await nextUrl(deps, spec.name, urls++);
      continue;
    }
    let answer: HttpAnswer;
    try {
      answer = await deps.get(current.url, received);
    } catch {
      throw new ArtifactError('download', IMAGE_DOWNLOAD_FAILED);
    }
    if (answer.status === 403) {
      current = await nextUrl(deps, spec.name, urls++);
      continue;
    }
    if (answer.status === 416 && received > 0) break;
    if (answer.status === 200 && received > 0) {
      deps.fs.truncate(spec.file);
      hash = createHash('sha256');
      received = 0;
    }
    if (answer.status !== 200 && answer.status !== 206) throw new ArtifactError('download', IMAGE_DOWNLOAD_FAILED);
    try {
      for await (const chunk of answer.body) {
        hash.update(chunk);
        deps.fs.append(spec.file, chunk);
        received += chunk.length;
        deps.onProgress?.(received);
      }
      break;
    } catch {
      if (deps.now() < current.expiresAt) throw new ArtifactError('download', IMAGE_DOWNLOAD_FAILED);
      current = await nextUrl(deps, spec.name, urls++);
    }
  }
  if (hash.digest('hex') !== spec.sha256) {
    deps.fs.remove(spec.file);
    throw new ArtifactError('mismatch', IMAGE_MISMATCH);
  }
  return spec.file;
}
