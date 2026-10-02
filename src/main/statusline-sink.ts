import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

import { ClaudeSettingsConfig, getClaudeSettingsPath, writeClaudeSettings } from './claude-settings';
import { findGitBash } from './git-bash';
import { parseJsonText, STATUSLINE_CHAIN_FILE, STATUSLINE_SCRIPT_NAME, STATUSLINE_SINK_FILE } from '../shared/usage';

/**
 * Installing the statusline sink into a managed config dir's settings.json.
 * A statusLine the user set is moved to a sidecar file and chained to, so it
 * keeps rendering; nothing is written when the entry is already current, and a
 * sidecar already there outlives a settings.json that names no statusLine.
 */

export type SinkInstallAction = 'installed' | 'updated' | 'unchanged' | 'error';
export type SinkUninstallAction = 'restored' | 'removed' | 'unchanged' | 'error';

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
 * How the sink runs: this app's own binary in Node mode, so it needs no `node`
 * on the PATH a statusLine command inherits.
 */
export interface SinkLaunch {
  scriptPath: string;
  execPath: string;
  platform: NodeJS.Platform;
}

function shellQuote(value: string): string {
  const escaped = value.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
}

/**
 * The statusLine command. The CLI runs it under sh, or Git Bash on Windows, so
 * one POSIX form serves every OS; it does nothing once the script is gone.
 */
export function sinkCommand(launch: SinkLaunch, configDir: string): string {
  const shellPath = (p: string) => shellQuote(launch.platform === 'win32' ? p.replaceAll('\\', '/') : p);
  const script = shellPath(launch.scriptPath);
  const run = ['ELECTRON_RUN_AS_NODE=1', shellPath(launch.execPath), script, shellPath(configDir)].join(' ');
  return `if [ -f ${script} ]; then ${run}; fi`;
}

export interface SinkHost {
  execPath: string;
  platform: NodeJS.Platform;
  gitBash: () => string | null;
}

const THIS_HOST: SinkHost = {
  execPath: process.execPath,
  platform: process.platform,
  gitBash: () => findGitBash(process.env),
};

/**
 * The launch for this app, or null when the build carries no sink script or,
 * on Windows, the CLI would run statusLine under PowerShell for want of Git Bash.
 */
export function sinkLaunchFor(scriptPath: string | null, host: SinkHost = THIS_HOST): SinkLaunch | null {
  if (!scriptPath) return null;
  if (host.platform === 'win32' && !host.gitBash()) {
    log.warn('[Usage] Git Bash not found, so the CLI runs statusLine under PowerShell; the sink stays off');
    return null;
  }
  return { scriptPath, execPath: host.execPath, platform: host.platform };
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

/**
 * The settings object, `{}` when there is no file, or null when the file is
 * not a JSON object, which must never be rewritten.
 */
function loadSettings(configDir: string): ClaudeSettingsConfig | null {
  const file = getClaudeSettingsPath(configDir);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = parseJsonText(fs.readFileSync(file, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as ClaudeSettingsConfig) : null;
  } catch {
    return null;
  }
}

export function installStatuslineSink(configDir: string, launch: SinkLaunch): SinkInstallAction {
  const settings = loadSettings(configDir);
  if (!settings) return 'error';
  const current = settings.statusLine as StatusLineEntry | undefined;
  const command = sinkCommand(launch, configDir);

  if (isOurs(current) && current?.command === command) return 'unchanged';

  let action: SinkInstallAction = 'updated';
  if (!isOurs(current)) {
    if (current?.command && !saveChain(configDir, current)) return 'error';
    action = 'installed';
  }

  settings.statusLine = { ...current, type: 'command', command };
  if (!writeClaudeSettings(settings, configDir)) return 'error';
  return action;
}

/** Whether a user statusLine is on record for the sink in this dir to chain to. */
export function hasSavedChain(configDir: string): boolean {
  return readSavedChain(configDir)?.chain != null;
}

/** The statusLine install moved aside, or null when the record cannot be read. */
function readSavedChain(configDir: string): { chain: StatusLineEntry | null } | null {
  const file = chainFilePath(configDir);
  if (!fs.existsSync(file)) return { chain: null };
  try {
    const chain = (parseJsonText(fs.readFileSync(file, 'utf-8')) as { chain?: StatusLineEntry } | null)?.chain;
    return { chain: typeof chain?.command === 'string' ? chain : null };
  } catch {
    return null;
  }
}

/**
 * Take the sink out of a config dir, putting back the statusLine it chained to.
 * A statusLine that is not ours is left alone, and so is everything when the
 * saved entry cannot be read, since removing ours then would lose the user's.
 */
export function uninstallStatuslineSink(configDir: string): SinkUninstallAction {
  const settings = loadSettings(configDir);
  if (!settings) return 'error';
  if (!isOurs(settings.statusLine as StatusLineEntry | undefined)) return 'unchanged';

  const saved = readSavedChain(configDir);
  if (!saved) return 'error';
  const userEntry = saved.chain;
  if (userEntry) settings.statusLine = { type: 'command', ...userEntry };
  else delete settings.statusLine;
  if (!writeClaudeSettings(settings, configDir)) return 'error';
  saveChain(configDir, null);
  return userEntry ? 'restored' : 'removed';
}

/**
 * Keeps one config dir's sink matching the preference: installed while wanted
 * and runnable, taken out otherwise.
 */
export function sinkReconciler(
  launch: SinkLaunch | null,
  isEnabled: () => boolean,
): (configDir: string) => SinkInstallAction | SinkUninstallAction {
  return configDir => (launch && isEnabled() ? installStatuslineSink(configDir, launch) : uninstallStatuslineSink(configDir));
}
