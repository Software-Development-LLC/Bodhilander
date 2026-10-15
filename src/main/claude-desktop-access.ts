/**
 * Claude Desktop access: a dedicated paired device whose credential, and the
 * API port, are written where the Claude Desktop extension looks for them.
 * The token lives only in a user-only file; unpairing invalidates it at once.
 */
import * as fs from 'fs';
import * as path from 'path';
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
  unpairDevice(deviceId: string): boolean;
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
  extensionPath: () => string | null;
}

/** Temp file then rename, so the extension never reads a half-written file. */
function writePrivate(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
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
    const device = ourDevices()[0] ?? null;
    return {
      enabled: device !== null && fs.existsSync(discoveryFile),
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
      for (const stale of ourDevices()) deps.pairing.unpairDevice(stale.id);
      const { token } = deps.pairing.createDevice(CLAUDE_DESKTOP_DEVICE_NAME, CLAUDE_DESKTOP_PLATFORM, {
        canControl: true,
        canModify: true,
      });
      writePrivate(credFile, token);
    }
    writeDiscovery(port);
    return status();
  }

  function disable(): ClaudeDesktopStatus {
    for (const device of ourDevices()) deps.pairing.unpairDevice(device.id);
    removeFiles();
    return status();
  }

  /** The API can come back on a different port; an enabled extension follows it. */
  function onApiStarted(port: number): void {
    if (fs.existsSync(discoveryFile) && currentDevice()) writeDiscovery(port);
  }

  /** Unpairing from the device list leaves nothing behind for the extension to read. */
  function onDeviceUnpaired(): void {
    if (ourDevices().length === 0) removeFiles();
  }

  return { status, enable, disable, onApiStarted, onDeviceUnpaired, dir: claudeDesktopDir(deps.userData) };
}

export type ClaudeDesktopAccess = ReturnType<typeof createClaudeDesktopAccess>;
