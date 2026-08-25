/**
 * Restores a bundle onto this machine: source-machine paths rebuilt against
 * this one, transcripts landed where the CLI reads them. Row ids are
 * preserved, which is what makes a second import a no-op.
 */

import * as fs from 'fs';
import * as path from 'path';
import type DatabaseCtor from 'better-sqlite3';
import log from 'electron-log';
import { carryTranscript, isPathSafeConversationId } from '../conversation-transcript';
import { seedLegacyConversations } from '../legacy-claude-seed';
import { DEFAULT_PROVIDER_ID, isKnownProvider } from '../providers';
import {
  BUNDLE_FORMAT_VERSION,
  decodeBundle,
  LEGACY_ACCOUNT_KEY,
  looksLikeBundle,
  TABLES_ENTRY,
  TRANSCRIPT_PREFIX,
  type DecodedBundle,
  type PortableTables,
  type TransferManifest,
} from './bundle-format';
import { remapWorkingDir, type WorkingDirMapping } from './working-dirs';

type Db = DatabaseCtor.Database;


export interface ImportOptions {
  /** This machine's `<userData>/claude-accounts`. */
  accountsRoot: string;
  /** This machine's `~/.claude`, where legacy-key transcripts land. */
  legacyConfigDir: string;
  /** Scratch space; removed when the import finishes. */
  stagingDir: string;
  mappings: WorkingDirMapping[];
  /** Injectable so remapping can be exercised without a real filesystem. */
  directoryExists?: (dir: string) => boolean;
}

export interface ImportOutcome {
  /** Null for a v1 portable JSON, which predates the manifest. */
  manifest: TransferManifest | null;
  groups: number;
  sessions: number;
  sessionEvents: number;
  chatEvents: number;
  arenaRuns: number;
  arenaResponses: number;
  preferences: number;
  accounts: number;
  transcripts: number;
  skippedGroups: number;
  skippedSessions: number;
  /** Session ids restored into the needs-relink state. */
  needsRelink: string[];
}

interface ParsedBundle {
  manifest: TransferManifest | null;
  tables: PortableTables;
  bundle: DecodedBundle | null;
}

const NOT_A_BUNDLE = 'This file is not a Bodhilander transfer bundle.';

function emptyTables(v1: { sourceApp?: string; exportedAt?: string; groups: any[]; sessions: any[] }): PortableTables {
  return {
    version: BUNDLE_FORMAT_VERSION,
    sourceApp: v1.sourceApp ?? 'bodhilander',
    exportedAt: v1.exportedAt ?? new Date().toISOString(),
    groups: v1.groups,
    sessions: v1.sessions,
    sessionEvents: [],
    chatEvents: [],
    arenaRuns: [],
    arenaResponses: [],
    preferences: [],
    accounts: [],
  };
}

function parseBundle(bytes: Buffer): ParsedBundle {
  if (looksLikeBundle(bytes)) {
    const bundle = decodeBundle(bytes);
    const tables = bundle.read(TABLES_ENTRY);
    if (!tables) throw new Error('Transfer bundle is missing its data.');
    return { manifest: bundle.manifest, tables: JSON.parse(tables.toString('utf-8')), bundle };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(bytes.toString('utf-8'));
  } catch {
    throw new Error(NOT_A_BUNDLE);
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.groups) || !Array.isArray(parsed.sessions)) {
    throw new Error(NOT_A_BUNDLE);
  }
  return { manifest: null, tables: emptyTables(parsed), bundle: null };
}

/** The manifest an import shows the user before it changes anything. */
export function readBundleManifest(bytes: Buffer): TransferManifest | null {
  return parseBundle(bytes).manifest;
}

/** Unknown ids — a bundle from a newer build — must never reach the DB. */
function sanitizeProvider(provider: string | null | undefined): string {
  const id = provider ?? DEFAULT_PROVIDER_ID;
  return isKnownProvider(id) ? id : DEFAULT_PROVIDER_ID;
}

function idsIn(db: Db, table: string, column = 'id'): Set<string> {
  return new Set((db.prepare(`SELECT ${column} AS id FROM ${table}`).all() as { id: string }[]).map((r) => r.id));
}

// ---------------------------------------------------------------------------
// The transactional half
// ---------------------------------------------------------------------------

interface RowCounts {
  groups: number;
  sessions: number;
  sessionEvents: number;
  chatEvents: number;
  arenaRuns: number;
  arenaResponses: number;
  preferences: number;
  accounts: number;
  skippedGroups: number;
  skippedSessions: number;
  needsRelink: string[];
}

/** Accounts the restore can legally point a group or session at. */
function knownAccountIds(db: Db, tables: PortableTables): Set<string> {
  return new Set([...idsIn(db, 'claude_accounts'), ...tables.accounts.map((a) => a.id)]);
}

function restoreGroups(db: Db, tables: PortableTables, options: ImportOptions, groupIds: Set<string>) {
  const accounts = knownAccountIds(db, tables);
  const insert = db.prepare(`
    INSERT INTO groups (id, name, color, working_dir, "order", created_at, parent_id, collapsed, claude_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let skipped = 0;
  for (const group of tables.groups) {
    if (groupIds.has(group.id)) {
      skipped++;
      continue;
    }
    const accountId = (group as { claudeAccountId?: string | null }).claudeAccountId;
    insert.run(
      group.id,
      group.name,
      group.color ?? '#888888',
      remapWorkingDir(group.workingDir ?? '', options.mappings),
      group.order ?? 0,
      group.createdAt,
      group.parentId ?? null,
      group.collapsed ? 1 : 0,
      accountId && accounts.has(accountId) ? accountId : null,
    );
    groupIds.add(group.id);
    inserted++;
  }
  return { inserted, skipped };
}

function restoreSessions(
  db: Db,
  tables: PortableTables,
  options: ImportOptions,
  groupIds: Set<string>,
  sessionIds: Set<string>,
) {
  const exists = options.directoryExists ?? ((dir: string) => fs.existsSync(dir));
  const accounts = knownAccountIds(db, tables);
  const insert = db.prepare(`
    INSERT INTO sessions (id, group_id, name, working_dir, state, shell_type, "order", created_at,
                          last_activity_at, claude_session_id, ended_at, duration_seconds, claude_account_id, provider)
    VALUES (?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, NULL, 0, ?, ?)
  `);

  let inserted = 0;
  let skipped = 0;
  const needsRelink: string[] = [];

  for (const session of tables.sessions) {
    if (sessionIds.has(session.id) || !groupIds.has(session.groupId)) {
      skipped++;
      continue;
    }
    const workingDir = remapWorkingDir(session.workingDir ?? '', options.mappings);
    if (workingDir === '' || !exists(workingDir)) needsRelink.push(session.id);

    insert.run(
      session.id,
      session.groupId,
      session.name,
      workingDir,
      session.shellType || 'bash',
      session.order ?? 0,
      session.createdAt,
      session.lastActivityAt,
      session.claudeSessionId ?? null,
      session.claudeAccountId && accounts.has(session.claudeAccountId) ? session.claudeAccountId : null,
      sanitizeProvider(session.provider),
    );
    sessionIds.add(session.id);
    inserted++;
  }
  return { inserted, skipped, needsRelink };
}

function restoreEvents(db: Db, tables: PortableTables, sessionIds: Set<string>) {
  const existingEvents = idsIn(db, 'session_events');
  const existingChat = idsIn(db, 'chat_events');

  const insertEvent = db.prepare(
    'INSERT INTO session_events (id, session_id, event_type, event_data, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  let sessionEvents = 0;
  for (const event of tables.sessionEvents) {
    if (existingEvents.has(event.id) || !sessionIds.has(event.sessionId)) continue;
    insertEvent.run(event.id, event.sessionId, event.eventType, event.eventData ?? null, event.createdAt);
    sessionEvents++;
  }

  const insertChat = db.prepare(
    'INSERT INTO chat_events (id, session_id, type, payload, timestamp) VALUES (?, ?, ?, ?, ?)',
  );
  let chatEvents = 0;
  for (const event of tables.chatEvents) {
    if (existingChat.has(event.id) || !sessionIds.has(event.sessionId)) continue;
    insertChat.run(event.id, event.sessionId, event.type, event.payload, event.timestamp);
    chatEvents++;
  }

  return { sessionEvents, chatEvents };
}

function restoreArena(db: Db, tables: PortableTables, options: ImportOptions) {
  const existingRuns = idsIn(db, 'arena_runs');
  const existingResponses = idsIn(db, 'arena_responses');

  const insertRun = db.prepare('INSERT INTO arena_runs (id, prompt, working_dir, created_at) VALUES (?, ?, ?, ?)');
  let arenaRuns = 0;
  for (const run of tables.arenaRuns) {
    if (existingRuns.has(run.id)) continue;
    const dir = run.workingDir ? remapWorkingDir(run.workingDir, options.mappings) : null;
    insertRun.run(run.id, run.prompt, dir, run.createdAt);
    arenaRuns++;
  }

  const insertResponse = db.prepare(`
    INSERT INTO arena_responses (id, run_id, provider, status, response_text, ttft_ms, total_ms,
                                 input_tokens, output_tokens, cost_usd, error, round, prompt, session_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let arenaResponses = 0;
  for (const response of tables.arenaResponses) {
    if (existingResponses.has(response.id)) continue;
    insertResponse.run(
      response.id, response.runId, response.provider, response.status, response.responseText ?? '',
      response.ttftMs ?? null, response.totalMs ?? null, response.inputTokens ?? null,
      response.outputTokens ?? null, response.costUsd ?? null, response.error ?? null,
      response.round ?? 0, response.prompt ?? null, response.sessionRef ?? null,
    );
    arenaResponses++;
  }

  return { arenaRuns, arenaResponses };
}

/**
 * Settings the destination has already chosen are left alone. An overwrite
 * would make a second import undo whatever the user changed in between, which
 * is the one thing a restore must never do.
 */
function restorePreferences(db: Db, tables: PortableTables): number {
  const existing = idsIn(db, 'preferences', 'key');
  const insert = db.prepare('INSERT INTO preferences (key, value) VALUES (?, ?)');

  let inserted = 0;
  for (const preference of tables.preferences) {
    if (existing.has(preference.key)) continue;
    insert.run(preference.key, preference.value ?? null);
    inserted++;
  }
  return inserted;
}

function restoreAccounts(db: Db, tables: PortableTables, options: ImportOptions): number {
  const existing = idsIn(db, 'claude_accounts');
  const insert = db.prepare(`
    INSERT INTO claude_accounts (id, label, config_dir, email, color, is_default, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `);

  let inserted = 0;
  for (const account of tables.accounts) {
    if (existing.has(account.id)) continue;
    insert.run(
      account.id,
      account.label,
      destinationConfigDir(options.accountsRoot, account.id),
      account.email ?? null,
      account.color ?? '#888888',
      account.createdAt,
      account.lastUsedAt ?? null,
    );
    inserted++;
  }

  promoteDefaultAccount(db, tables);
  return inserted;
}

function restoreRows(db: Db, tables: PortableTables, options: ImportOptions): RowCounts {
  const groupIds = idsIn(db, 'groups');
  const sessionIds = idsIn(db, 'sessions');

  const groups = restoreGroups(db, tables, options, groupIds);
  const sessions = restoreSessions(db, tables, options, groupIds, sessionIds);
  const events = restoreEvents(db, tables, sessionIds);
  const arena = restoreArena(db, tables, options);

  return {
    groups: groups.inserted,
    sessions: sessions.inserted,
    sessionEvents: events.sessionEvents,
    chatEvents: events.chatEvents,
    arenaRuns: arena.arenaRuns,
    arenaResponses: arena.arenaResponses,
    preferences: restorePreferences(db, tables),
    accounts: restoreAccounts(db, tables, options),
    skippedGroups: groups.skipped,
    skippedSessions: sessions.skipped,
    needsRelink: sessions.needsRelink,
  };
}

/** Where an account's config dir lives on THIS machine (see account-auth). */
function destinationConfigDir(accountsRoot: string, accountId: string): string {
  return path.join(accountsRoot, accountId, '.claude');
}

/**
 * A machine with accounts and no default falls back to the legacy login for
 * every session, so the restore fills the gap — but never displaces a default
 * this machine already chose.
 */
function promoteDefaultAccount(db: Db, tables: PortableTables): void {
  const current = db.prepare('SELECT id FROM claude_accounts WHERE is_default = 1 LIMIT 1').get();
  if (current) return;

  const preferred = tables.accounts.find((a) => a.isDefault)?.id;
  const fallback = db.prepare('SELECT id FROM claude_accounts ORDER BY created_at, id LIMIT 1').get() as any;
  const promote = preferred ?? fallback?.id;
  if (promote) db.prepare('UPDATE claude_accounts SET is_default = 1 WHERE id = ?').run(promote);
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/** One path component the bundle chose: never a separator, never traversal. */
function isSafeSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..' && !/[\\/]/.test(segment);
}

interface StagedTranscripts {
  /** Account key → the staged dir, shaped like a config dir. */
  byAccount: Map<string, string>;
  /** Account key → the conversation ids staged under it. */
  conversations: Map<string, string[]>;
}

function stageTranscripts(bundle: DecodedBundle, stagingDir: string): StagedTranscripts {
  const byAccount = new Map<string, string>();
  const conversations = new Map<string, string[]>();

  for (const name of bundle.entryNames()) {
    if (!name.startsWith(TRANSCRIPT_PREFIX)) continue;
    const parts = name.slice(TRANSCRIPT_PREFIX.length).split('/');
    if (parts.length !== 3 || !parts.every(isSafeSegment)) {
      log.warn(`[Transfer] Skipping transcript entry with an unexpected path: ${name}`);
      continue;
    }

    const [accountKey, slug, file] = parts;
    const uuid = file.replace(/\.jsonl$/, '');
    if (uuid === file || !isPathSafeConversationId(uuid)) {
      log.warn(`[Transfer] Skipping transcript entry with an unexpected conversation id: ${name}`);
      continue;
    }

    const configDir = path.join(stagingDir, accountKey);
    const target = path.join(configDir, 'projects', slug);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, file), bundle.read(name)!);

    byAccount.set(accountKey, configDir);
    conversations.set(accountKey, [...(conversations.get(accountKey) ?? []), uuid]);
  }

  return { byAccount, conversations };
}

/**
 * Land the staged trees. A config dir with no history takes the whole tree in
 * one copy; one that already has history is filled in per conversation, so an
 * import never clobbers what is already there.
 */
async function landTranscripts(staged: StagedTranscripts, restoredAccounts: Set<string>, options: ImportOptions): Promise<number> {
  let landed = 0;

  for (const [accountKey, stagedDir] of staged.byAccount) {
    const target = accountKey === LEGACY_ACCOUNT_KEY
      ? options.legacyConfigDir
      : destinationConfigDir(options.accountsRoot, accountKey);
    if (accountKey !== LEGACY_ACCOUNT_KEY && !restoredAccounts.has(accountKey)) continue;

    const conversations = staged.conversations.get(accountKey) ?? [];
    if (await seedLegacyConversations(target, stagedDir)) {
      landed += conversations.length;
      continue;
    }
    for (const uuid of conversations) {
      if (carryTranscript(uuid, stagedDir, target)) landed++;
    }
  }

  return landed;
}

// ---------------------------------------------------------------------------

/**
 * Restore a bundle. The database work is one transaction, so a failure part-way
 * leaves the existing database exactly as it was; transcripts are landed only
 * once that has committed.
 */
export async function restoreTransferBundle(db: Db, bytes: Buffer, options: ImportOptions): Promise<ImportOutcome> {
  const { manifest, tables, bundle } = parseBundle(bytes);
  const counts = db.transaction(() => restoreRows(db, tables, options))();

  let transcripts = 0;
  if (bundle) {
    const staged = stageTranscripts(bundle, options.stagingDir);
    try {
      transcripts = await landTranscripts(staged, idsIn(db, 'claude_accounts'), options);
    } finally {
      fs.rmSync(options.stagingDir, { recursive: true, force: true });
    }
  }

  return { manifest, transcripts, ...counts };
}
