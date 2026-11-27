/**
 * Crew in the main process: the Hub connection plus the runtime around it.
 * Crew is shown to everyone; with no Hub reachable it reads as unavailable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, Notification, safeStorage } from 'electron';
import log from 'electron-log';
import { resolveAccountIdentity } from '../account-identity';
import { getDatabase } from '../database';
import { getAllAccounts } from '../repositories/accounts';
import { claudePath } from '../run-engine/machine-config';
import { getUsage, setUsage } from '../usage-store';
import { CrewSignIn, type Reminder } from './crew-token';
import { startCrewRuntime, type CrewRuntime } from './crew-runtime';
import type { HubClient } from './hub-client';
import { getCrewHub, setCrewHubReplaced, setCrewInterrupt, startCrewHub, stopCrewHub } from './hub-service';
import type { CrewJob, Prepared } from './run/loop';
import { HOLD_SETUP, prepareRun, type PrepareDeps } from './run/prepare';

/** Runs stay held until the approve broker their --permission-prompt-tool names is served. */
export const APPROVE_BROKER_READY = false;

let runtime: CrewRuntime | null = null;
let runtimeHub: HubClient | null = null;

const listDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

function reminderText(reminder: Reminder, label: string): string {
  const when = new Date(reminder.endsAt).toLocaleString();
  return reminder.mode === 'token' ? `${label}'s Crew sign-in ends ${when}. Set up the token again before then.` : `${label}'s Crew sign-in ends ${when}. Sign in again for Crew before then.`;
}

export function crewPrepareDeps(signIn: CrewSignIn): PrepareDeps {
  const userData = app.getPath('userData');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return {
    db: getDatabase(),
    signIn,
    accounts: getAllAccounts,
    loggedIn: (dir) => resolveAccountIdentity(dir).loggedIn,
    userData,
    home: os.homedir(),
    claudePath: claudePath(),
    env: process.env,
    timeZone: () => null,
    handbook: () => '',
    mcpServers: () => ({}),
    sandbox: () => ({
      accountDirs: getAllAccounts().map((a) => a.configDir),
      userDataEntries: listDir(userData),
      crewEntries: listDir(path.join(userData, 'crew')),
      sockets: [],
      socketRoot: `/tmp/cr-${uid}`,
      allowedDomains: [],
    }),
  };
}

function attach(hub: HubClient): CrewRuntime {
  runtime?.stop();
  const db = getDatabase();
  const signIn = new CrewSignIn(db, safeStorage);
  const prepareDeps = crewPrepareDeps(signIn);
  runtimeHub = hub;
  runtime = startCrewRuntime({
    db,
    hub,
    signIn,
    accounts: getAllAccounts,
    prepare: (job: CrewJob, threadKey: string): Promise<Prepared> =>
      APPROVE_BROKER_READY ? prepareRun(prepareDeps, job, threadKey) : Promise.resolve({ hold: HOLD_SETUP }),
    usage: { get: getUsage, set: setUsage },
    remind: (reminder, account) => {
      try {
        new Notification({ title: 'Bodhi Crew', body: reminderText(reminder, account.label) }).show();
      } catch (err) {
        log.warn('[Crew] could not show a sign-in reminder', err);
      }
    },
  });
  return runtime;
}

export function startCrew(): CrewRuntime {
  setCrewHubReplaced((hub) => attach(hub));
  setCrewInterrupt((hireId) => runtime?.interrupt(hireId));
  const hub = startCrewHub();
  return runtime && runtimeHub === hub ? runtime : attach(hub);
}

export function stopCrew(): void {
  setCrewHubReplaced(null);
  runtime?.stop();
  runtime = null;
  runtimeHub = null;
  setCrewInterrupt(null);
  stopCrewHub();
}

export function crewRuntime(): CrewRuntime | null {
  return getCrewHub() ? runtime : null;
}
