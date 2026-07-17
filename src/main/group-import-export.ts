/**
 * Group & Session Import/Export
 *
 * Portable JSON format for transferring groups and sessions between
 * Bodhilander and ClaudeLander (or any compatible app). Sessions carry their
 * claudeSessionId so Claude Code conversations can be resumed after import.
 */

import { dialog, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import * as groupsRepo from './repositories/groups';
import * as sessionsRepo from './repositories/sessions';
import { isKnownProvider, DEFAULT_PROVIDER_ID } from './providers';
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
// Portable format types
// ---------------------------------------------------------------------------

interface PortableGroup {
  id: string;
  name: string;
  color: string;
  workingDir: string;
  parentId: string | null;
  collapsed: boolean;
  order: number;
  createdAt: string; // ISO 8601
}

interface PortableSession {
  id: string;
  groupId: string;
  name: string;
  workingDir: string;
  shellType: string;
  claudeSessionId: string | null;
  order: number;
  createdAt: string;
  lastActivityAt: string;
  /** Agent provider registry id (#96); absent in exports from older versions. */
  provider?: string;
}

interface PortableData {
  version: 1;
  sourceApp: string;
  exportedAt: string;
  groups: PortableGroup[];
  sessions: PortableSession[];
}

interface ExportResult {
  success: boolean;
  filePath?: string;
  error?: string;
  groupCount?: number;
  sessionCount?: number;
}

interface ImportResult {
  success: boolean;
  error?: string;
  groupCount?: number;
  sessionCount?: number;
  skippedGroups?: number;
  skippedSessions?: number;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function exportGroupsAndSessions(): Promise<ExportResult> {
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

export async function importGroupsAndSessions(): Promise<ImportResult> {
  try {
    const result = await dialog.showOpenDialog({
      title: 'Import Groups & Sessions',
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'Import cancelled' };
    }

    const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
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
