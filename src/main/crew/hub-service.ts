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
let resumeWired = false;
let interruptHook: ((hireId: string) => void) | null = null;

/** The run loop registers here, so a lost lease reaches the run it covers. */
export function setCrewInterrupt(fn: ((hireId: string) => void) | null): void {
  interruptHook = fn;
}

export function crewHubUrl(): string {
  return resolveHubUrl(app.isPackaged, getPreference(HUB_URL_PREF));
}

export function getCrewHub(): HubClient | null {
  return client;
}

/** Call after app ready. Safe to call again: the running client is kept unless crew.hubUrl changed. */
export function startCrewHub(): HubClient {
  const hubUrl = crewHubUrl();
  if (client?.hubUrl === hubUrl) {
    client.start();
    return client;
  }
  client?.stop();
  const hub = new HubClient({
    db: getDatabase(),
    hubUrl,
    getMachineId: () => getPreference(MACHINE_ID_PREF),
    forgetMachineId: () => deletePreference(MACHINE_ID_PREF),
    sign: signWithIdentity,
    connect: (url, options) => new WebSocket(url, options) as unknown as HubSocket,
    interruptRun: (hireId) => interruptHook?.(hireId),
  });
  client = hub;
  if (!resumeWired) {
    resumeWired = true;
    powerMonitor.on('resume', () => client?.onResume());
  }
  hub.on('status', (status) => log.info(`[Crew] Hub ${status}`));
  hub.start();
  return hub;
}

/** A new link stored a new machine id, so the connection starts over. */
export function restartCrewHub(): HubClient {
  client?.stop();
  client = null;
  return startCrewHub();
}

/** Part of the quit cleanup; `will-quit` never fires after the hard exit there. */
export function stopCrewHub(): void {
  client?.stop();
}

function machineName(): string {
  const saved = getPreference(RELAY_NAME_PREF)?.trim();
  if (saved) return saved;
  return os.hostname();
}

/** One click of Link this machine. Throws when the system keychain is unavailable. */
export function newLinkFlow(): LinkFlow {
  const keys = ensureIdentity();
  const name = machineName();
  return new LinkFlow({
    hubUrl: crewHubUrl(),
    keys,
    name,
    sign: signWithIdentity,
    now: () => Date.now(),
    fetch: (url, init) => fetch(url, init),
    storeMachineId: (machineId) => setPreference(MACHINE_ID_PREF, machineId),
    openExternal: (url) => void shell.openExternal(url),
    connect: () => restartCrewHub(),
  });
}
