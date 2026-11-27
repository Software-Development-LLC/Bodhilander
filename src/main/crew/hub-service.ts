/**
 * The app's single Crew Hub connection, built from the relay's machine key.
 * It connects only once this machine holds a `crew.machineId`, so a machine
 * that never linked opens nothing.
 */
import * as os from 'os';
import { app, powerMonitor, shell } from 'electron';
import log from 'electron-log';
import { WebSocket } from 'ws';
import { getDatabase } from '../database';
import { deletePreference, getPreference, setPreference } from '../repositories/preferences';
import { ensureIdentity, signWithIdentity } from '../api/relay/relay-identity';
import { HUB_URL_PREF, HubClient, MACHINE_ID_PREF, resolveHubUrl, type HubSocket } from './hub-client';
import { LinkFlow } from './hub-link';

const RELAY_NAME_PREF = 'relay.machineName';

let client: HubClient | null = null;

export function crewHubUrl(): string {
  return resolveHubUrl(app.isPackaged, getPreference(HUB_URL_PREF));
}

export function getCrewHub(): HubClient | null {
  return client;
}

/** Call after app ready. Safe to call again; a second call returns the running client. */
export function startCrewHub(): HubClient {
  if (client) {
    client.start();
    return client;
  }
  const hub = new HubClient({
    db: getDatabase(),
    hubUrl: crewHubUrl(),
    getMachineId: () => getPreference(MACHINE_ID_PREF),
    forgetMachineId: () => deletePreference(MACHINE_ID_PREF),
    sign: signWithIdentity,
    connect: (url, options) => new WebSocket(url, options) as unknown as HubSocket,
    // Runs arrive with the run loop; until then there is never one to interrupt.
    interruptRun: () => {},
  });
  client = hub;
  powerMonitor.on('resume', () => hub.onResume());
  app.on('will-quit', () => hub.stop());
  hub.on('status', (status) => log.info(`[Crew] Hub ${status}`));
  hub.start();
  return hub;
}

/** One click of Link this machine. Throws when the system keychain is unavailable. */
export function newLinkFlow(): LinkFlow {
  const keys = ensureIdentity();
  const saved = getPreference(RELAY_NAME_PREF)?.trim();
  const name = saved ? saved : os.hostname();
  return new LinkFlow({
    hubUrl: crewHubUrl(),
    keys,
    name,
    sign: signWithIdentity,
    now: () => Date.now(),
    fetch: (url, init) => fetch(url, init),
    storeMachineId: (machineId) => setPreference(MACHINE_ID_PREF, machineId),
    openExternal: (url) => void shell.openExternal(url),
    connect: () => startCrewHub(),
  });
}
