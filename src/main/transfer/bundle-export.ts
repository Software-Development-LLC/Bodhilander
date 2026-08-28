/**
 * Reads a machine's portable state into a transfer bundle. Takes its database
 * handle rather than reaching for the app's, so the exclusion rules can be
 * checked against a produced archive instead of against the filter.
 */

import * as fs from 'fs';
import * as path from 'path';
import type DatabaseCtor from 'better-sqlite3';
import {
  BUNDLE_FORMAT_VERSION,
  encodeBundle,
  formatBytes,
  isPortablePreferenceKey,
  LEGACY_ACCOUNT_KEY,
  TABLES_ENTRY,
  TRANSCRIPT_PREFIX,
  type BundleEntry,
  type PortableTables,
  type TransferManifest,
} from './bundle-format';
import { collectWorkingDirRoots } from './working-dirs';

type Db = DatabaseCtor.Database;

/**
 * The archive is assembled in memory so its exact size can be quoted before a
 * file is written. That trade needs a ceiling: past this, refuse and say so
 * rather than let a very large transcript store exhaust the heap.
 */
export const MAX_TRANSCRIPT_BYTES = 1024 * 1024 * 1024;

export interface ExportOptions {
  sourceAppVersion: string;
  sourcePlatform: string;
  /** The source machine's userData root, recorded for the import to report. */
  sourceUserData: string;
  /** Pre-accounts `~/.claude`; its transcripts travel under the legacy key. */
  legacyConfigDir: string;
  /** Overridable so the ceiling can be exercised without a huge fixture. */
  maxTranscriptBytes?: number;
  /**
   * Ids of providers holding an API key here. Names, never values — the keys
   * themselves cannot leave this machine's keychain, and the destination needs
   * to know which ones to ask for. Absent when the caller cannot tell.
   */
  providersWithApiKeys?: string[];
}

export interface BuiltBundle {
  bytes: Buffer;
  manifest: TransferManifest;
}

interface AccountRow {
  id: string;
  label: string;
  config_dir: string;
  email: string | null;
  color: string | null;
  is_default: number;
  created_at: string;
  last_used_at: string | null;
}

/**
 * Every portable table, in the shape the v1 exporter wrote plus the tables v2
 * adds. `claude_accounts.config_dir` is deliberately not among them: it is an
 * absolute path into the source machine's userData and is rebuilt on import.
 */
function readPortableTables(db: Db): PortableTables {
  const groups = db.prepare('SELECT * FROM groups ORDER BY "order", created_at, id').all() as any[];
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY "order", created_at, id').all() as any[];
  const accounts = db.prepare('SELECT * FROM claude_accounts ORDER BY created_at, id').all() as AccountRow[];

  return {
    version: BUNDLE_FORMAT_VERSION,
    sourceApp: 'bodhilander',
    exportedAt: new Date().toISOString(),
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color ?? '#888888',
      workingDir: g.working_dir ?? '',
      parentId: g.parent_id ?? null,
      collapsed: Boolean(g.collapsed),
      order: g.order ?? 0,
      createdAt: g.created_at,
    })),
    sessions: sessions.map((s) => ({
      id: s.id,
      groupId: s.group_id,
      name: s.name,
      workingDir: s.working_dir,
      shellType: s.shell_type ?? 'bash',
      claudeSessionId: s.claude_session_id ?? null,
      order: s.order ?? 0,
      createdAt: s.created_at,
      lastActivityAt: s.last_activity_at,
      provider: s.provider ?? 'claude',
      claudeAccountId: s.claude_account_id ?? null,
    })),
    sessionEvents: (db.prepare('SELECT * FROM session_events ORDER BY created_at, id').all() as any[]).map((e) => ({
      id: e.id,
      sessionId: e.session_id,
      eventType: e.event_type,
      eventData: e.event_data ?? null,
      createdAt: e.created_at,
    })),
    chatEvents: (db.prepare('SELECT * FROM chat_events ORDER BY timestamp, id').all() as any[]).map((e) => ({
      id: e.id,
      sessionId: e.session_id,
      type: e.type,
      payload: e.payload,
      timestamp: e.timestamp,
    })),
    arenaRuns: (db.prepare('SELECT * FROM arena_runs ORDER BY created_at, id').all() as any[]).map((r) => ({
      id: r.id,
      prompt: r.prompt,
      workingDir: r.working_dir ?? null,
      createdAt: r.created_at,
    })),
    arenaResponses: (db.prepare('SELECT * FROM arena_responses ORDER BY run_id, round, id').all() as any[]).map((r) => ({
      id: r.id,
      runId: r.run_id,
      provider: r.provider,
      status: r.status,
      responseText: r.response_text ?? '',
      ttftMs: r.ttft_ms ?? null,
      totalMs: r.total_ms ?? null,
      inputTokens: r.input_tokens ?? null,
      outputTokens: r.output_tokens ?? null,
      costUsd: r.cost_usd ?? null,
      error: r.error ?? null,
      round: r.round ?? 0,
      prompt: r.prompt ?? null,
      sessionRef: r.session_ref ?? null,
    })),
    preferences: (db.prepare('SELECT key, value FROM preferences ORDER BY key').all() as any[])
      .filter((p) => isPortablePreferenceKey(p.key))
      .map((p) => ({ key: p.key, value: p.value ?? null })),
    accounts: accounts.map((a) => ({
      id: a.id,
      label: a.label,
      email: a.email ?? null,
      color: a.color ?? '#888888',
      isDefault: Boolean(a.is_default),
      createdAt: a.created_at,
      lastUsedAt: a.last_used_at ?? null,
    })),
  };
}

interface TranscriptFile {
  entryName: string;
  filePath: string;
  size: number;
}

/** `<configDir>/projects/<slug>/<uuid>.jsonl` — nothing else in the tree. */
function listTranscripts(configDir: string, accountKey: string): TranscriptFile[] {
  const projects = path.join(configDir, 'projects');
  let slugs: fs.Dirent[];
  try {
    slugs = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: TranscriptFile[] = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    let files: string[];
    try {
      files = fs.readdirSync(path.join(projects, slug.name));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(projects, slug.name, file);
      try {
        found.push({
          entryName: `${TRANSCRIPT_PREFIX}${accountKey}/${slug.name}/${file}`,
          filePath,
          size: fs.statSync(filePath).size,
        });
      } catch {
        continue; // unreadable file: the rest of the archive is still worth writing
      }
    }
  }
  return found;
}

/** Every account's transcript tree, plus the pre-accounts one if it is separate. */
function transcriptRoots(db: Db, legacyConfigDir: string): { key: string; dir: string }[] {
  const roots = (db.prepare('SELECT id, config_dir FROM claude_accounts').all() as any[]).map((a) => ({
    key: a.id as string,
    dir: a.config_dir as string,
  }));
  const seen = new Set(roots.map((a) => path.resolve(a.dir)));
  if (!seen.has(path.resolve(legacyConfigDir))) {
    roots.push({ key: LEGACY_ACCOUNT_KEY, dir: legacyConfigDir });
  }
  return roots;
}

/**
 * What the transcripts weigh uncompressed, by stat alone. Nothing is read, so
 * a caller can ask whether a bundle could possibly fit somewhere before paying
 * to build one.
 */
export function measureTranscriptBytes(db: Db, legacyConfigDir: string): number {
  return transcriptRoots(db, legacyConfigDir)
    .flatMap((a) => listTranscripts(a.dir, a.key))
    .reduce((sum, file) => sum + file.size, 0);
}

/** Sizes come from stat, so the ceiling is checked before a byte is read. */
export class TranscriptVolumeError extends Error {}

function readWithinBudget(files: TranscriptFile[], budget: number): BundleEntry[] {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > budget) {
    throw new TranscriptVolumeError(
      `Conversation transcripts total ${formatBytes(total)}, over the ${formatBytes(budget)} ` +
      'a transfer bundle can hold. Prune older conversations and try again.',
    );
  }

  const entries: BundleEntry[] = [];
  for (const file of files) {
    try {
      entries.push({ name: file.entryName, data: fs.readFileSync(file.filePath) });
    } catch {
      continue; // raced away since the scan: the rest is still worth writing
    }
  }
  return entries;
}

/**
 * Build the archive in memory so its exact size is known before anything is
 * written — the caller shows that number and only then asks for a location.
 */
export function buildTransferBundle(db: Db, options: ExportOptions): BuiltBundle {
  const tables = readPortableTables(db);

  const transcripts = readWithinBudget(
    transcriptRoots(db, options.legacyConfigDir).flatMap((a) => listTranscripts(a.dir, a.key)),
    options.maxTranscriptBytes ?? MAX_TRANSCRIPT_BYTES,
  );
  const workingDirRoots = collectWorkingDirRoots([
    ...tables.groups.map((g) => g.workingDir),
    ...tables.sessions.map((s) => s.workingDir),
  ]);

  const manifest: TransferManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    sourceApp: 'bodhilander',
    sourceAppVersion: options.sourceAppVersion,
    sourcePlatform: options.sourcePlatform,
    sourceUserData: options.sourceUserData,
    exportedAt: tables.exportedAt,
    workingDirRoots,
    // Omitted rather than empty when the caller did not say: "no provider had
    // a key" and "nobody looked" are different answers, and the report reads
    // them differently.
    ...(options.providersWithApiKeys ? { providersWithApiKeys: [...options.providersWithApiKeys].sort() } : {}),
    counts: {
      groups: tables.groups.length,
      sessions: tables.sessions.length,
      sessionEvents: tables.sessionEvents.length,
      chatEvents: tables.chatEvents.length,
      arenaRuns: tables.arenaRuns.length,
      arenaResponses: tables.arenaResponses.length,
      preferences: tables.preferences.length,
      accounts: tables.accounts.length,
      transcripts: transcripts.length,
    },
  };

  const tablesEntry: BundleEntry = { name: TABLES_ENTRY, data: Buffer.from(JSON.stringify(tables), 'utf-8') };
  return { bytes: encodeBundle(manifest, [tablesEntry, ...transcripts]), manifest };
}
