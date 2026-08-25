/**
 * The dialog-driven half: everything that needs Electron. The archive is built
 * in memory so its real size can be shown before a location is asked for, and
 * an import is two steps so the roots can be answered in between.
 */

import { app, dialog } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import log from 'electron-log';
import { legacyClaudeConfigDir } from '../conversation-transcript';
import { getDatabase } from '../database';
import { buildTransferBundle } from './bundle-export';
import { BUNDLE_EXTENSION, formatBytes, type TransferCounts } from './bundle-format';
import { readBundleManifest, restoreTransferBundle } from './bundle-import';
import type { WorkingDirMapping } from './working-dirs';
import type { TransferImportResult, TransferInspectResult } from '../../shared/types';

export interface TransferExportResult {
  success: boolean;
  filePath?: string;
  error?: string;
  sizeLabel?: string;
  counts?: TransferCounts;
}

function accountsRoot(): string {
  return path.join(app.getPath('userData'), 'claude-accounts');
}

function summarise(counts: TransferCounts): string {
  return [
    `${counts.groups} group(s)`,
    `${counts.sessions} session(s)`,
    `${counts.transcripts} conversation transcript(s)`,
    `${counts.accounts} account(s)`,
    `${counts.preferences} setting(s)`,
  ].join('\n');
}

export async function exportTransferBundle(): Promise<TransferExportResult> {
  try {
    const { bytes, manifest } = buildTransferBundle(getDatabase(), {
      sourceAppVersion: app.getVersion(),
      sourcePlatform: process.platform,
      sourceUserData: app.getPath('userData'),
      legacyConfigDir: legacyClaudeConfigDir(),
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
        `${summarise(manifest.counts)}\n\n` +
        'API keys, Teams tokens and the relay identity are left behind — they cannot be decrypted on another machine.',
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
    log.info(`[Transfer] Wrote ${sizeLabel} bundle to ${chosen.filePath}`);
    return { success: true, filePath: chosen.filePath, sizeLabel, counts: manifest.counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[Transfer] Export failed:', message);
    return { success: false, error: message };
  }
}

/** Step one of an import: read the manifest so the roots can be mapped. */
export async function inspectTransferBundle(): Promise<TransferInspectResult> {
  try {
    const chosen = await dialog.showOpenDialog({
      title: 'Open Transfer Bundle',
      filters: [
        { name: 'Bodhilander Bundle', extensions: [BUNDLE_EXTENSION] },
        { name: 'Portable Export (older)', extensions: ['json'] },
      ],
      properties: ['openFile'],
    });
    if (chosen.canceled || chosen.filePaths.length === 0) return { success: false, error: 'Import cancelled' };

    const filePath = chosen.filePaths[0];
    const bytes = fs.readFileSync(filePath);
    return {
      success: true,
      filePath,
      manifest: readBundleManifest(bytes),
      sizeLabel: formatBytes(bytes.length),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[Transfer] Could not read bundle:', message);
    return { success: false, error: message };
  }
}

/** Step two: restore, with the user's answer for each working-directory root. */
export async function importTransferBundle(
  filePath: string,
  mappings: WorkingDirMapping[],
): Promise<TransferImportResult> {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhilander-transfer-'));
  try {
    const outcome = await restoreTransferBundle(getDatabase(), fs.readFileSync(filePath), {
      accountsRoot: accountsRoot(),
      legacyConfigDir: legacyClaudeConfigDir(),
      stagingDir,
      mappings,
    });
    log.info(
      `[Transfer] Restored ${outcome.groups} group(s), ${outcome.sessions} session(s), ` +
      `${outcome.transcripts} transcript(s); ${outcome.needsRelink.length} need relinking`,
    );
    return {
      success: true,
      groups: outcome.groups,
      sessions: outcome.sessions,
      transcripts: outcome.transcripts,
      needsRelink: outcome.needsRelink.length,
      skippedGroups: outcome.skippedGroups,
      skippedSessions: outcome.skippedSessions,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[Transfer] Import failed:', message);
    return { success: false, error: message };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
