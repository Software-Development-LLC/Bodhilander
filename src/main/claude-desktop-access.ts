/**
 * Claude Desktop access: a dedicated paired device whose credential, and the
 * API port, are written where the Claude Desktop extension looks for them.
 * The server confines the token to loopback and the extension's routes, and
 * the discovery file exists only while the API is up.
 */
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import type { PairedDevice } from './api/pairing/pairing-manager';
import type { ClaudeDesktopStatus } from '../shared/types';
import {
  CLAUDE_DESKTOP_DEVICE_NAME,
  CLAUDE_DESKTOP_PLATFORM,
  DISCOVERY_VERSION,
  claudeDesktopDir,
  credentialPath,
  discoveryPath,
  serializeDiscovery,
} from '../shared/claude-desktop';

export interface AccessPairing {
  getAllDevices(): PairedDevice[];
  createDevice(
    name: string,
    platform: string,
    permissions: { canControl: boolean; canModify: boolean },
  ): { device: PairedDevice; token: string };
  validateToken(token: string): PairedDevice | null;
}

export interface AccessApi {
  isRunning(): boolean;
  port(): number | null;
  start(): Promise<{ port: number }>;
}

export interface AccessDeps {
  userData: string;
  pairing: AccessPairing;
  api: AccessApi;
  /** Unpairs through the API server, so the device's open connections close too. */
  unpair: (deviceId: string) => boolean;
  extensionPath: () => string | null;
}

/**
 * Temp file then rename, so the extension never reads a half-written file.
 * The modes are ignored on Windows, where %APPDATA% is already per-user.
 */
function writePrivate(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function createClaudeDesktopAccess(deps: AccessDeps) {
  const credFile = credentialPath(deps.userData);
  const discoveryFile = discoveryPath(deps.userData);

  const ourDevices = () => deps.pairing.getAllDevices().filter((d) => d.platform === CLAUDE_DESKTOP_PLATFORM);

  function removeFiles(): void {
    fs.rmSync(discoveryFile, { force: true });
    fs.rmSync(credFile, { force: true });
  }

  function writeDiscovery(port: number): void {
    writePrivate(discoveryFile, serializeDiscovery({ version: DISCOVERY_VERSION, port, credentialPath: credFile }));
  }

  /** The device the stored credential still unlocks, if any. */
  function currentDevice(): PairedDevice | null {
    const token = readOrNull(credFile)?.trim();
    if (!token) return null;
    const device = deps.pairing.validateToken(token);
    return device?.platform === CLAUDE_DESKTOP_PLATFORM ? device : null;
  }

  function status(): ClaudeDesktopStatus {
    const device = currentDevice();
    return {
      enabled: device !== null,
      deviceId: device?.id ?? null,
      apiRunning: deps.api.isRunning(),
      port: deps.api.port(),
      extensionAvailable: deps.extensionPath() !== null,
    };
  }

  async function enable(): Promise<ClaudeDesktopStatus> {
    let port = deps.api.port();
    if (!deps.api.isRunning() || port === null) {
      try {
        port = (await deps.api.start()).port;
      } catch (err) {
        throw new Error(`The local API server could not start: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!currentDevice()) {
      for (const stale of ourDevices()) deps.unpair(stale.id);
      const { token } = deps.pairing.createDevice(CLAUDE_DESKTOP_DEVICE_NAME, CLAUDE_DESKTOP_PLATFORM, {
        canControl: true,
        canModify: true,
      });
      writePrivate(credFile, token);
    }
    writeDiscovery(port);
    log.info(`[ClaudeDesktop] Access enabled on port ${port}`);
    return status();
  }

  function disable(): ClaudeDesktopStatus {
    for (const device of ourDevices()) deps.unpair(device.id);
    removeFiles();
    log.info('[ClaudeDesktop] Access disabled');
    return status();
  }

  /** The API can come back on a different port; an enabled extension follows it. */
  function onApiStarted(port: number): void {
    if (currentDevice()) writeDiscovery(port);
  }

  /** A port nothing of ours listens on must not be advertised: another process could take it. */
  function onApiStopped(): void {
    fs.rmSync(discoveryFile, { force: true });
  }

  /** Unpairing from the device list leaves nothing behind for the extension to read. */
  function onDeviceUnpaired(): void {
    if (ourDevices().length > 0) return;
    removeFiles();
    log.info('[ClaudeDesktop] Device unpaired; extension files removed');
  }

  return { status, enable, disable, onApiStarted, onApiStopped, onDeviceUnpaired, dir: claudeDesktopDir(deps.userData) };
}

export type ClaudeDesktopAccess = ReturnType<typeof createClaudeDesktopAccess>;
