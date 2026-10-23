/**
 * IPC for Settings → Claude Desktop. Every action answers with a result
 * rather than throwing, so the renderer can show what went wrong.
 */
import * as fs from 'fs';
import log from 'electron-log';
import { MCPB_FILE_NAME } from '../shared/claude-desktop';
import type { ClaudeDesktopActionResult } from '../shared/types';
import type { ClaudeDesktopAccess } from './claude-desktop-access';

export interface ClaudeDesktopIpcDeps {
  handle: (channel: string, handler: () => unknown) => void;
  access: () => ClaudeDesktopAccess;
  extensionPath: () => string | null;
  openPath: (file: string) => Promise<string>;
  chooseSavePath: (defaultName: string) => Promise<string | null>;
  copyFile?: (from: string, to: string) => void;
}

const STARTED_API =
  'The local API server was stopped, so it has been started: Claude Desktop reaches Bodhilander through it.';
const NO_EXTENSION = 'This build does not include the Claude Desktop extension.';

async function attempt(action: () => Promise<ClaudeDesktopActionResult>): Promise<ClaudeDesktopActionResult> {
  try {
    return await action();
  } catch (error) {
    log.error('[ClaudeDesktop] Action failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export function registerClaudeDesktopIpc(deps: ClaudeDesktopIpcDeps): void {
  const copyFile = deps.copyFile ?? ((from, to) => fs.copyFileSync(from, to));

  deps.handle('claudeDesktop:getStatus', () => deps.access().status());

  deps.handle('claudeDesktop:enable', () =>
    attempt(async () => {
      const wasRunning = deps.access().status().apiRunning;
      const status = await deps.access().enable();
      if (wasRunning || !status.apiRunning) return { success: true, status };
      return { success: true, status, message: STARTED_API };
    }));

  deps.handle('claudeDesktop:disable', () =>
    attempt(async () => ({ success: true, status: await deps.access().disable() })));

  deps.handle('claudeDesktop:install', () =>
    attempt(async () => {
      const file = deps.extensionPath();
      if (!file) return { success: false, error: NO_EXTENSION };
      const failure = await deps.openPath(file);
      if (failure) return { success: false, error: `Could not open the extension: ${failure}` };
      return { success: true, status: deps.access().status() };
    }));

  deps.handle('claudeDesktop:saveExtension', () =>
    attempt(async () => {
      const file = deps.extensionPath();
      if (!file) return { success: false, error: NO_EXTENSION };
      const target = await deps.chooseSavePath(MCPB_FILE_NAME);
      const status = deps.access().status();
      if (!target) return { success: true, status };
      copyFile(file, target);
      return { success: true, status, message: `Saved to ${target}` };
    }));
}
