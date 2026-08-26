/**
 * Group & session import/export, and the whole-machine transfer bundle.
 *
 * The portable JSON is what ClaudeLander and older versions read; the bundle
 * adds history, settings, accounts and the transcripts `--resume` reads.
 */

import { dialog, app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import * as groupsRepo from './repositories/groups';
import * as sessionsRepo from './repositories/sessions';
import * as accountsRepo from './repositories/accounts';
import { isKnownProvider, DEFAULT_PROVIDER_ID } from './providers';
import { getDatabase } from './database';
import { legacyClaudeConfigDir } from './conversation-transcript';
import { registerHooks } from './mcp-config';
import { buildTransferBundle } from './transfer/bundle-export';
import { readBundleManifest, restoreTransferBundle } from './transfer/bundle-import';
import { BUNDLE_EXTENSION, formatBytes, looksLikeBundle } from './transfer/bundle-format';
import type { PortableExportResult, PortableImportResult } from '../shared/types';
import type { PortableDataV1 as PortableData } from './transfer/bundle-format';
import type { WorkingDirMapping } from './transfer/working-dirs';
import log from 'electron-log';

/**
 * Validate an imported provider id at import time (#96). Unknown ids — e.g.
 * an export written by a newer app version — are logged and defaulted here so
 * they never land in the DB, rather than relying solely on the launch-path
 * fallback. Exported for tests.
 */
export function sanitizeImportedProvider(provider: string | null | undefined): string {
  const id = provider ?? DEFAULT_PROVIDER_ID;
  if (!isKnownProvider(id)) {
    log.warn(`[Import/Export] Unknown provider '${id}' in imported session; defaulting to '${DEFAULT_PROVIDER_ID}'`);
    return DEFAULT_PROVIDER_ID;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

type ExportResult = PortableExportResult;

type ImportResult = PortableImportResult;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Which of the two formats the user wants. The portable JSON is still what
 * another app reads; the bundle is the whole machine.
 */
async function askExportFormat(): Promise<'bundle' | 'portable' | 'cancel'> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Everything on this machine…', 'Groups & sessions only…', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Export',
    message: 'What should the export carry?',
    detail:
      'Everything: groups, sessions, history, settings, accounts and conversation transcripts, ' +
      'as one transfer bundle for a new machine.\n\n' +
      'Groups & sessions only: the portable JSON older versions and ClaudeLander read.',
  });
  const choices = ['bundle', 'portable', 'cancel'] as const;
  return choices[response] ?? 'cancel';
}

async function exportTransferBundle(legacyDir: string = legacyClaudeConfigDir()): Promise<ExportResult> {
  try {
    const { bytes, manifest } = buildTransferBundle(getDatabase(), {
      sourceAppVersion: app.getVersion(),
      sourcePlatform: process.platform,
      sourceUserData: app.getPath('userData'),
      legacyConfigDir: legacyDir,
    });
    const sizeLabel = formatBytes(bytes.length);

    const confirm = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Save Bundle…', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Transfer Bundle',
      message: `This bundle will be ${sizeLabel}.`,
      detail:
        `${manifest.counts.groups} group(s), ${manifest.counts.sessions} session(s), ` +
        `${manifest.counts.transcripts} conversation transcript(s), ` +
        `${manifest.counts.accounts} account(s), ${manifest.counts.preferences} setting(s).\n\n` +
        'API keys, Teams tokens and the relay identity stay here — they cannot be decrypted elsewhere.',
    });
    if (confirm.response !== 0) return { success: false, error: 'Export cancelled' };

    const defaultName = `bodhilander-transfer-${new Date().toISOString().slice(0, 10)}.${BUNDLE_EXTENSION}`;
    const chosen = await dialog.showSaveDialog({
      title: 'Save Transfer Bundle',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'Bodhilander Bundle', extensions: [BUNDLE_EXTENSION] }],
    });
    if (chosen.canceled || !chosen.filePath) return { success: false, error: 'Export cancelled' };

    fs.writeFileSync(chosen.filePath, bytes);
    log.info(`[Import/Export] Wrote ${sizeLabel} transfer bundle to ${chosen.filePath}`);
    return {
      success: true,
      filePath: chosen.filePath,
      groupCount: manifest.counts.groups,
      sessionCount: manifest.counts.sessions,
      sizeLabel,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('[Import/Export] Transfer bundle export failed:', msg);
    return { success: false, error: msg };
  }
}

export async function exportGroupsAndSessions(legacyDir?: string): Promise<ExportResult> {
  const choice = await askExportFormat();
  if (choice === 'cancel') return { success: false, error: 'Export cancelled' };
  if (choice === 'bundle') return exportTransferBundle(legacyDir);
  return exportPortableJson();
}

async function exportPortableJson(): Promise<ExportResult> {
  try {
    const groups = groupsRepo.getAllGroups();
    const sessions = sessionsRepo.getAllSessions();

    const data: PortableData = {
      version: 1,
      sourceApp: 'bodhilander',
      exportedAt: new Date().toISOString(),
      groups: groups.map(g => ({
        id: g.id,
        name: g.name,
        color: g.color,
        workingDir: g.workingDir,
        parentId: g.parentId,
        collapsed: g.collapsed,
        order: g.order,
        createdAt: g.createdAt instanceof Date ? g.createdAt.toISOString() : String(g.createdAt),
      })),
      sessions: sessions.map(s => ({
        id: s.id,
        groupId: s.groupId,
        name: s.name,
        workingDir: s.workingDir,
        shellType: s.shellType,
        claudeSessionId: s.claudeSessionId ?? null,
        order: s.order,
        createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : String(s.createdAt),
        lastActivityAt: s.lastActivityAt instanceof Date ? s.lastActivityAt.toISOString() : String(s.lastActivityAt),
        provider: s.provider ?? 'claude',
      })),
    };

    const defaultName = `bodhilander-export-${new Date().toISOString().slice(0, 10)}`;
    const result = await dialog.showSaveDialog({
      title: 'Export Groups & Sessions',
      defaultPath: path.join(app.getPath('documents'), `${defaultName}.json`),
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Export cancelled' };
    }

    fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
    log.info(`[Import/Export] Exported ${groups.length} groups, ${sessions.length} sessions to ${result.filePath}`);

    return {
      success: true,
      filePath: result.filePath,
      groupCount: groups.length,
      sessionCount: sessions.length,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('[Import/Export] Export failed:', msg);
    return { success: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Ask where each of the source machine's working-directory roots lives here.
 * Null means the user abandoned the import; an empty answer for one root is
 * allowed and leaves those paths as they were.
 */
export async function askRootMappings(roots: string[]): Promise<WorkingDirMapping[] | null> {
  const mappings: WorkingDirMapping[] = [];

  for (const root of roots) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Choose Folder…', 'Leave As Is', 'Cancel Import'],
      defaultId: 0,
      cancelId: 2,
      title: 'Where does this folder live now?',
      message: root,
      detail:
        'Point this at the same tree on this machine. Left as is, any session under it ' +
        'whose folder is missing arrives marked for relinking rather than failing to start.',
    });
    if (response === 2) return null;
    if (response !== 0) continue;

    const chosen = await dialog.showOpenDialog({
      title: `New location for ${root}`,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!chosen.canceled && chosen.filePaths.length > 0) {
      mappings.push({ from: root, to: chosen.filePaths[0] });
    }
  }
  return mappings;
}

/**
 * Hooks are what make a session report its state. Registering them only at
 * window creation left every restored account silent until the next launch.
 */
export function registerRestoredAccountHooks(): void {
  for (const account of accountsRepo.getAllAccounts()) {
    const result = registerHooks(account.configDir);
    if (!result.success) {
      log.warn(`[Import/Export] Hook registration failed for ${account.configDir}:`, result.error);
    }
  }
}

async function importTransferBundle(bytes: Buffer, legacyDir: string): Promise<ImportResult> {
  const manifest = readBundleManifest(bytes);
  const mappings = await askRootMappings(manifest?.workingDirRoots ?? []);
  if (mappings === null) return { success: false, error: 'Import cancelled' };

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhilander-transfer-'));
  try {
    const outcome = await restoreTransferBundle(getDatabase(), bytes, {
      accountsRoot: path.join(app.getPath('userData'), 'claude-accounts'),
      legacyConfigDir: legacyDir,
      stagingDir,
      mappings,
    });
    registerRestoredAccountHooks();
    log.info(
      `[Import/Export] Restored ${outcome.groups} group(s), ${outcome.sessions} session(s), ` +
      `${outcome.transcripts} transcript(s); ${outcome.needsRelink.length} need relinking`,
    );
    return {
      success: true,
      groupCount: outcome.groups,
      sessionCount: outcome.sessions,
      skippedGroups: outcome.skippedGroups,
      skippedSessions: outcome.skippedSessions,
      transcriptCount: outcome.transcripts,
      needsRelinkCount: outcome.needsRelink.length,
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

export async function importGroupsAndSessions(legacyDir: string = legacyClaudeConfigDir()): Promise<ImportResult> {
  try {
    const result = await dialog.showOpenDialog({
      title: 'Import Groups & Sessions',
      filters: [
        { name: 'Bodhilander Bundle', extensions: [BUNDLE_EXTENSION] },
        { name: 'JSON Files', extensions: ['json'] },
      ],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'Import cancelled' };
    }

    const bytes = fs.readFileSync(result.filePaths[0]);
    if (looksLikeBundle(bytes)) return await importTransferBundle(bytes, legacyDir);

    const raw = bytes.toString('utf-8');
    const data: PortableData = JSON.parse(raw);

    if (data.version !== 1 || !Array.isArray(data.groups) || !Array.isArray(data.sessions)) {
      return { success: false, error: 'Invalid export file format' };
    }

    // Build a map from old group IDs → new group IDs
    const existingGroups = new Set(groupsRepo.getAllGroups().map(g => g.id));
    const existingSessions = new Set(sessionsRepo.getAllSessions().map(s => s.id));
    const groupIdMap = new Map<string, string>();

    let groupCount = 0;
    let skippedGroups = 0;

    // First pass: create groups without parentId (resolve hierarchy after)
    // Sort so that top-level groups (parentId == null) come first
    const sorted = [...data.groups].sort((a, b) => {
      if (a.parentId === null && b.parentId !== null) return -1;
      if (a.parentId !== null && b.parentId === null) return 1;
      return 0;
    });

    for (const g of sorted) {
      if (existingGroups.has(g.id)) {
        // ID collision — map to existing
        groupIdMap.set(g.id, g.id);
        skippedGroups++;
        continue;
      }

      const newId = randomUUID();
      groupIdMap.set(g.id, newId);

      const resolvedParentId = g.parentId ? (groupIdMap.get(g.parentId) ?? null) : null;

      groupsRepo.createGroup({
        id: newId,
        name: g.name,
        color: g.color,
        workingDir: g.workingDir,
        parentId: resolvedParentId,
        collapsed: g.collapsed,
        order: g.order,
        createdAt: new Date(g.createdAt),
        claudeAccountId: null,
      });
      groupCount++;
    }

    let sessionCount = 0;
    let skippedSessions = 0;

    for (const s of data.sessions) {
      const mappedGroupId = groupIdMap.get(s.groupId);
      if (!mappedGroupId) {
        skippedSessions++;
        continue; // orphan session — group wasn't imported
      }

      if (existingSessions.has(s.id)) {
        skippedSessions++;
        continue;
      }

      sessionsRepo.createSession({
        id: randomUUID(),
        groupId: mappedGroupId,
        name: s.name,
        workingDir: s.workingDir,
        state: 'idle',
        shellType: s.shellType || 'bash',
        claudeSessionId: s.claudeSessionId ?? null,
        order: s.order,
        createdAt: new Date(s.createdAt),
        lastActivityAt: new Date(s.lastActivityAt),
        endedAt: null,
        durationSeconds: 0,
        claudeAccountId: null,
        provider: sanitizeImportedProvider(s.provider),
        // A brand-new session has never been failed over (#207).
        failoverFromAccountId: null,
        failoverPrevAccountId: null,
      });
      sessionCount++;
    }

    log.info(`[Import/Export] Imported ${groupCount} groups, ${sessionCount} sessions (skipped ${skippedGroups} groups, ${skippedSessions} sessions)`);

    return {
      success: true,
      groupCount,
      sessionCount,
      skippedGroups,
      skippedSessions,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('[Import/Export] Import failed:', msg);
    return { success: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Direct import from ClaudeLander database
// ---------------------------------------------------------------------------

function findClaudeLanderDb(): string | null {
  // ClaudeLander stores its DB at {userData}/claudelander.db
  // On Windows: %APPDATA%/claudelander/claudelander.db
  // On macOS:   ~/Library/Application Support/claudelander/claudelander.db
  // On Linux:   ~/.config/claudelander/claudelander.db
  const appData = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library', 'Application Support')
      : path.join(process.env.HOME || '', '.config'));

  const dbPath = path.join(appData, 'claudelander', 'claudelander.db');
  if (fs.existsSync(dbPath)) return dbPath;

  // Also check legacy "ClaudeLander" casing
  const dbPathAlt = path.join(appData, 'ClaudeLander', 'claudelander.db');
  if (fs.existsSync(dbPathAlt)) return dbPathAlt;

  return null;
}

export async function importFromClaudeLander(): Promise<ImportResult> {
  try {
    const dbPath = findClaudeLanderDb();

    if (!dbPath) {
      return {
        success: false,
        error: 'ClaudeLander database not found. Make sure ClaudeLander has been installed and run at least once.',
      };
    }

    log.info(`[Import/Export] Opening ClaudeLander database at ${dbPath}`);

    // Open read-only so we don't interfere with a running ClaudeLander
    const clDb = new Database(dbPath, { readonly: true });

    let clGroups: any[];
    let clSessions: any[];

    try {
      clGroups = clDb.prepare('SELECT * FROM groups ORDER BY "order"').all() as any[];
      clSessions = clDb.prepare('SELECT * FROM sessions ORDER BY "order"').all() as any[];
    } finally {
      clDb.close();
    }

    const existingGroups = new Set(groupsRepo.getAllGroups().map(g => g.id));
    const existingSessions = new Set(sessionsRepo.getAllSessions().map(s => s.id));
    const groupIdMap = new Map<string, string>();

    let groupCount = 0;
    let skippedGroups = 0;

    // Sort so top-level groups come first
    const sorted = [...clGroups].sort((a, b) => {
      if (a.parent_id === null && b.parent_id !== null) return -1;
      if (a.parent_id !== null && b.parent_id === null) return 1;
      return 0;
    });

    for (const row of sorted) {
      if (existingGroups.has(row.id)) {
        groupIdMap.set(row.id, row.id);
        skippedGroups++;
        continue;
      }

      const newId = randomUUID();
      groupIdMap.set(row.id, newId);
      const resolvedParentId = row.parent_id ? (groupIdMap.get(row.parent_id) ?? null) : null;

      groupsRepo.createGroup({
        id: newId,
        name: row.name,
        color: row.color || '#888888',
        workingDir: row.working_dir || '',
        parentId: resolvedParentId,
        collapsed: Boolean(row.collapsed),
        order: row.order || 0,
        createdAt: new Date(row.created_at || Date.now()),
        claudeAccountId: null,
      });
      groupCount++;
    }

    let sessionCount = 0;
    let skippedSessions = 0;

    for (const row of clSessions) {
      const mappedGroupId = groupIdMap.get(row.group_id);
      if (!mappedGroupId) {
        skippedSessions++;
        continue;
      }

      if (existingSessions.has(row.id)) {
        skippedSessions++;
        continue;
      }

      sessionsRepo.createSession({
        id: randomUUID(),
        groupId: mappedGroupId,
        name: row.name,
        workingDir: row.working_dir || '',
        state: 'idle',
        shellType: row.shell_type || 'bash',
        claudeSessionId: row.claude_session_id ?? null,
        order: row.order || 0,
        createdAt: new Date(row.created_at || Date.now()),
        lastActivityAt: new Date(row.last_activity_at || Date.now()),
        endedAt: null,
        durationSeconds: 0,
        claudeAccountId: null,
        provider: sanitizeImportedProvider(row.provider),
        // A brand-new session has never been failed over (#207).
        failoverFromAccountId: null,
        failoverPrevAccountId: null,
      });
      sessionCount++;
    }

    log.info(`[Import/Export] Direct import from ClaudeLander: ${groupCount} groups, ${sessionCount} sessions (skipped ${skippedGroups} groups, ${skippedSessions} sessions)`);

    return {
      success: true,
      groupCount,
      sessionCount,
      skippedGroups,
      skippedSessions,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('[Import/Export] Direct import from ClaudeLander failed:', msg);
    return { success: false, error: msg };
  }
}
