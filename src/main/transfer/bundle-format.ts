/**
 * The `.bodhilander-bundle` container: a plaintext header naming every entry,
 * then the entries' gzipped bytes. The header stays uncompressed so a build
 * that cannot read this version says so before decompressing anything.
 */

import * as zlib from 'zlib';
import type { TransferBundleCounts, TransferBundleManifest } from '../../shared/types';

const BUNDLE_MAGIC = 'BDHLBNDL';
export const BUNDLE_FORMAT_VERSION = 2;
export const BUNDLE_EXTENSION = 'bodhilander-bundle';

/** The tables payload: a superset of the v1 portable JSON. */
export const TABLES_ENTRY = 'data/tables.json';
export const TRANSCRIPT_PREFIX = 'transcripts/';

/**
 * Entry key for transcripts belonging to no registered account — the legacy
 * `~/.claude` tree that sessions resume against before any account exists.
 * Not a UUID, so it can never collide with a real account id.
 */
export const LEGACY_ACCOUNT_KEY = 'legacy';

// ---------------------------------------------------------------------------
// Portable table shapes. v1 carried groups and sessions; v2 adds the rest.
// ---------------------------------------------------------------------------

export interface PortableGroup {
  id: string;
  name: string;
  color: string;
  workingDir: string;
  parentId: string | null;
  collapsed: boolean;
  order: number;
  createdAt: string; // ISO 8601
}

export interface PortableSession {
  id: string;
  groupId: string;
  name: string;
  workingDir: string;
  shellType: string;
  claudeSessionId: string | null;
  order: number;
  createdAt: string;
  lastActivityAt: string;
  /** Agent provider registry id; absent in exports from older versions. */
  provider?: string;
  /** Account the session runs under; resolved to a restored account on import. */
  claudeAccountId?: string | null;
}

export interface PortableSessionEvent {
  id: string;
  sessionId: string;
  eventType: string;
  eventData: string | null;
  createdAt: string;
}

export interface PortableChatEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: string;
  timestamp: number;
}

export interface PortableArenaRun {
  id: string;
  prompt: string;
  workingDir: string | null;
  createdAt: string;
}

export interface PortableArenaResponse {
  id: string;
  runId: string;
  provider: string;
  status: string;
  responseText: string;
  ttftMs: number | null;
  totalMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  error: string | null;
  round: number;
  prompt: string | null;
  sessionRef: string | null;
}

export interface PortableAccount {
  id: string;
  label: string;
  email: string | null;
  color: string;
  isDefault: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PortablePreference {
  key: string;
  value: string | null;
}

/** The portable JSON as older builds wrote it, and still read it. */
export interface PortableDataV1 {
  version: 1;
  sourceApp: string;
  exportedAt: string;
  groups: PortableGroup[];
  sessions: PortableSession[];
}

export interface PortableTables extends Omit<PortableDataV1, 'version'> {
  version: typeof BUNDLE_FORMAT_VERSION;
  sessionEvents: PortableSessionEvent[];
  chatEvents: PortableChatEvent[];
  arenaRuns: PortableArenaRun[];
  arenaResponses: PortableArenaResponse[];
  preferences: PortablePreference[];
  accounts: PortableAccount[];
}

export type TransferCounts = TransferBundleCounts;
export type TransferManifest = TransferBundleManifest;

// ---------------------------------------------------------------------------
// Exclusion policy — enforced here, at export, never at import
// ---------------------------------------------------------------------------

/**
 * Preference namespaces sealed to the source machine's OS keychain, plus the
 * relay identity. Nothing under these can be decrypted anywhere else, and the
 * relay's machine model requires the destination to mint its own keypair.
 */
const EXCLUDED_PREFERENCE_PREFIXES = ['providerApiKey.', 'providerApiKeyUse.', 'relay.'] as const;

/** Secrets and settings that describe this machine rather than this user. */
const EXCLUDED_PREFERENCE_KEYS = new Set([
  'teamsTokens',
  'windowBounds',
  'customShellPath',
  'preferredEditor',
  'soundWaitingCustomPath',
  'soundErrorCustomPath',
  'soundStartCustomPath',
  'soundCompleteCustomPath',
  'legacyCodeSearchCleanupDone',
  'legacyMemoryCleanupDone',
  'legacyMemoryMcpCleanupDone',
]);

export function isPortablePreferenceKey(key: string): boolean {
  if (EXCLUDED_PREFERENCE_KEYS.has(key)) return false;
  return !EXCLUDED_PREFERENCE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface BundleEntry {
  name: string;
  data: Buffer;
}

interface EntryIndex {
  name: string;
  offset: number;
  length: number;
  rawLength: number;
}

interface BundleHeader {
  manifest: TransferManifest;
  entries: EntryIndex[];
}

const MAGIC_BYTES = Buffer.from(BUNDLE_MAGIC, 'ascii');
const HEADER_LENGTH_BYTES = 4;

export function encodeBundle(manifest: TransferManifest, entries: BundleEntry[]): Buffer {
  const payloads: Buffer[] = [];
  const index: EntryIndex[] = [];
  let offset = 0;

  for (const entry of entries) {
    const compressed = zlib.gzipSync(entry.data);
    index.push({ name: entry.name, offset, length: compressed.length, rawLength: entry.data.length });
    payloads.push(compressed);
    offset += compressed.length;
  }

  const header = Buffer.from(JSON.stringify({ manifest, entries: index } as BundleHeader), 'utf-8');
  const headerLength = Buffer.alloc(HEADER_LENGTH_BYTES);
  headerLength.writeUInt32BE(header.length, 0);
  return Buffer.concat([MAGIC_BYTES, headerLength, header, ...payloads]);
}

export interface DecodedBundle {
  manifest: TransferManifest;
  entryNames(): string[];
  /** Uncompressed bytes of one entry, or null when it is not in the archive. */
  read(name: string): Buffer | null;
}

export function looksLikeBundle(buffer: Buffer): boolean {
  return buffer.subarray(0, MAGIC_BYTES.length).equals(MAGIC_BYTES);
}

export function decodeBundle(buffer: Buffer): DecodedBundle {
  if (!looksLikeBundle(buffer)) {
    throw new Error('This file is not a Bodhilander transfer bundle.');
  }

  const headerStart = MAGIC_BYTES.length + HEADER_LENGTH_BYTES;
  if (buffer.length < headerStart) throw new Error('Transfer bundle is truncated.');
  const headerLength = buffer.readUInt32BE(MAGIC_BYTES.length);
  const bodyStart = headerStart + headerLength;
  if (buffer.length < bodyStart) throw new Error('Transfer bundle is truncated.');

  let header: BundleHeader;
  try {
    header = JSON.parse(buffer.subarray(headerStart, bodyStart).toString('utf-8'));
  } catch {
    throw new Error('Transfer bundle header is unreadable.');
  }

  const version = header.manifest?.formatVersion;
  if (version !== BUNDLE_FORMAT_VERSION) {
    throw new Error(
      `This transfer bundle was written by a newer version of Bodhilander (format ${version}). Update to import it.`,
    );
  }

  const byName = new Map(header.entries.map((e) => [e.name, e]));
  const last = header.entries[header.entries.length - 1];
  if (last && bodyStart + last.offset + last.length > buffer.length) {
    throw new Error('Transfer bundle is truncated.');
  }

  return {
    manifest: header.manifest,
    entryNames: () => header.entries.map((e) => e.name),
    read(name) {
      const entry = byName.get(name);
      if (!entry) return null;
      const start = bodyStart + entry.offset;
      return zlib.gunzipSync(buffer.subarray(start, start + entry.length));
    },
  };
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Archive size as it is shown to the user before the file is written. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}
