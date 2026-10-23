/**
 * The discovery-file contract between Bodhilander (the writer) and the Claude
 * Desktop extension (the reader). The extension runs under Claude Desktop's
 * Node, so nothing here may import Electron or src/main.
 */
import * as path from 'path';

export const CLAUDE_DESKTOP_DEVICE_NAME = 'Claude Desktop';
export const CLAUDE_DESKTOP_PLATFORM = 'claude-desktop';
export const CLAUDE_DESKTOP_DIR = 'claude-desktop';
export const DISCOVERY_FILE = 'discovery.json';
export const CREDENTIAL_FILE = 'credential';
export const DISCOVERY_VERSION = 1;
export const MCPB_FILE_NAME = 'bodhilander.mcpb';

/** The installed app's userData folder; the capitalised form covers case-sensitive filesystems. */
const APP_DIR_NAMES = ['bodhilander', 'Bodhilander'];
/** Unpackaged builds move userData into this subdirectory (see src/main/index.ts). */
const DEV_SUBDIR = 'dev';

export const NOT_ENABLED_MESSAGE =
  "Bodhilander isn't running or Claude Desktop access isn't enabled — open Bodhilander → Settings → Claude Desktop";

export interface DiscoveryFile {
  version: typeof DISCOVERY_VERSION;
  port: number;
  credentialPath: string;
}

export function claudeDesktopDir(userData: string): string {
  return path.join(userData, CLAUDE_DESKTOP_DIR);
}

export function discoveryPath(userData: string): string {
  return path.join(claudeDesktopDir(userData), DISCOVERY_FILE);
}

export function credentialPath(userData: string): string {
  return path.join(claudeDesktopDir(userData), CREDENTIAL_FILE);
}

/**
 * Where Bodhilander's userData can be, most likely first: the installed app,
 * then an unpackaged development build.
 */
export function userDataCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let base: string;
  if (platform === 'win32') {
    base = env.APPDATA ?? p.join(home, 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    base = p.join(home, 'Library', 'Application Support');
  } else {
    base = env.XDG_CONFIG_HOME ?? p.join(home, '.config');
  }
  const installed = APP_DIR_NAMES.map((name) => p.join(base, name));
  return [...installed, ...installed.map((dir) => p.join(dir, DEV_SUBDIR))];
}

export function serializeDiscovery(file: DiscoveryFile): string {
  return JSON.stringify(file, null, 2);
}

/** The parsed file, or null when it is not one this version can use. */
export function parseDiscovery(text: string): DiscoveryFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { version, port, credentialPath: cred } = parsed as Record<string, unknown>;
  if (version !== DISCOVERY_VERSION) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof cred !== 'string' || cred.length === 0) return null;
  return { version: DISCOVERY_VERSION, port, credentialPath: cred };
}
