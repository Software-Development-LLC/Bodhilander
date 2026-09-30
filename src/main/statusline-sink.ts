import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

import { getClaudeSettingsPath, readClaudeSettings, writeClaudeSettings } from './claude-settings';
import { STATUSLINE_CHAIN_FILE, STATUSLINE_SCRIPT_NAME, STATUSLINE_SINK_FILE } from '../shared/usage';

/**
 * Installing the statusline sink into a managed config dir's settings.json.
 * A statusLine the user set is moved to a sidecar file and chained to, so it
 * keeps rendering; nothing is written when the entry is already current.
 */

export type SinkInstallAction = 'installed' | 'updated' | 'unchanged' | 'error';

interface StatusLineEntry {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

export function sinkFilePath(configDir: string): string {
  return path.join(configDir, STATUSLINE_SINK_FILE);
}

function chainFilePath(configDir: string): string {
  return path.join(configDir, STATUSLINE_CHAIN_FILE);
}

/**
 * Whether `node` is on PATH. The sink runs as `node "<script>"`, so without it
 * the sink is not installed and a user's own statusLine is left in place.
 */
export function nodeOnPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync,
): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const names = platform === 'win32' ? ['node.exe', 'node.cmd'] : ['node'];
  const entries = (env.PATH ?? env.Path ?? '').split(pathApi.delimiter).filter(Boolean);
  return entries.some(dir => names.some(name => exists(pathApi.join(dir, name))));
}

export function sinkCommand(scriptPath: string, configDir: string): string {
  return `node "${scriptPath}" "${configDir}"`;
}

function isOurs(entry: StatusLineEntry | undefined): boolean {
  return typeof entry?.command === 'string' && entry.command.includes(STATUSLINE_SCRIPT_NAME);
}

function saveChain(configDir: string, chain: StatusLineEntry | null): boolean {
  const file = chainFilePath(configDir);
  try {
    if (chain) {
      const tmp = `${file}.bodhilander.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ chain }, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    return true;
  } catch (err) {
    log.warn(`[Usage] Could not record the existing statusLine for ${configDir}:`, err);
    return false;
  }
}

/** An existing settings.json that is not a JSON object must not be rewritten. */
function settingsUnreadable(configDir: string): boolean {
  const file = getClaudeSettingsPath(configDir);
  if (!fs.existsSync(file)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return typeof parsed !== 'object' || parsed === null || Array.isArray(parsed);
  } catch {
    return true;
  }
}

export function installStatuslineSink(configDir: string, scriptPath: string): SinkInstallAction {
  if (settingsUnreadable(configDir)) return 'error';
  const settings = readClaudeSettings(configDir);
  const current = settings.statusLine as StatusLineEntry | undefined;
  const command = sinkCommand(scriptPath, configDir);

  if (isOurs(current) && current?.command === command) return 'unchanged';

  let action: SinkInstallAction = 'updated';
  if (!isOurs(current)) {
    const userEntry = current?.command ? current : null;
    if (!saveChain(configDir, userEntry)) return 'error';
    action = 'installed';
  }

  const layout = current && 'padding' in current ? { padding: current.padding } : {};
  settings.statusLine = { ...layout, type: 'command', command };
  if (!writeClaudeSettings(settings, configDir)) return 'error';
  return action;
}
