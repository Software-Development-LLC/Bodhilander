/**
 * Crew in the main process: the Hub connection plus the runtime around it.
 * Crew is shown to everyone; with no Hub reachable it reads as unavailable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, Notification, safeStorage, shell } from 'electron';
import log from 'electron-log';
import { resolveAccountIdentity } from '../account-identity';
import { getDatabase } from '../database';
import { getAllAccounts } from '../repositories/accounts';
import { getCrewAccountCap, getPreference } from '../repositories/preferences';
import { claudePath, ghPath } from '../run-engine/machine-config';
import { getUsage, setUsage } from '../usage-store';
import { CrewSignIn, type Reminder } from './crew-token';
import { startCrewRuntime, type CrewRuntime } from './crew-runtime';
import { GithubGateway, runGh } from './gateway/github-gateway';
import { handbookFor, pinnedSkills, restoreSkills } from './handbook';
import { Holds, machineTimeZone } from './holds';
import { MACHINE_ID_PREF, type HubClient } from './hub-client';
import { getCrewHub, setCrewHubReplaced, setCrewInterrupt, startCrewHub, stopCrewHub } from './hub-service';
import type { RefusedFrame, TokenFrame } from './protocol';
import type { CrewJob, Prepared } from './run/loop';
import { sweepLetGo } from './let-go';
import type { HomeDeps } from './home';
import { McpHost, hostSocketPath } from './mcp/host';
import { resolveAccountRef } from './account-ref';
import { HireDayUsage } from './run/hire-usage';
import { prepareRun, type PrepareDeps } from './run/prepare';
import { RunServiceManager, ServicesNotReady } from './run/services';
import { reapLeftoverRuns, systemReap } from './run/reap';
import { socketRoot, sweepRunDirs } from './run/sockets';
import { RunSlots } from './run/slots';
import { crewTools } from './tools/server';
import { writeAudit } from './audit';
import { createWindowsCrew, type WindowsCrew } from './wsl-runtime';
import { windowsSetupDeps } from './wsl-main';

let runtime: CrewRuntime | null = null;
let runtimeHub: HubClient | null = null;
let host: McpHost | null = null;
let gateway: GithubGateway | null = null;
let services: RunServiceManager | null = null;
let detachHub: (() => void) | null = null;
let windowsCrew: WindowsCrew | null = null;
const holds = new Holds();
const slots = new RunSlots();

const listDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

function tellOwnerHere(text: string): void {
  try {
    new Notification({ title: 'Bodhi Crew', body: text }).show();
  } catch (err) {
    log.warn('[Crew] could not tell the owner', err);
  }
}

export function crewHomeDeps(hub: HubClient, signIn: CrewSignIn): HomeDeps {
  return {
    db: getDatabase(),
    machineId: () => getPreference(MACHINE_ID_PREF),
    online: () => hub.getStatus() === 'online',
    resolve: (ref) => resolveAccountRef(ref, getAllAccounts()),
    signedIn: (account) => signIn.signedIn(account.id, resolveAccountIdentity(account.configDir).loggedIn, Date.now()),
    raiseMove: (hireId, payload) => hub.sendMoveCard(hireId, payload),
    sendUnlink: (machineId) => hub.sendUnlink(machineId),
    tellOwner: tellOwnerHere,
  };
}

function reminderText(reminder: Reminder, label: string): string {
  const when = new Date(reminder.endsAt).toLocaleString();
  return reminder.mode === 'token' ? `${label}'s Crew sign-in ends ${when}. Set up the token again before then.` : `${label}'s Crew sign-in ends ${when}. Sign in again for Crew before then.`;
}

/** In dev the sources under the app; packaged, the unpacked build and the extra resources. */
export function crewResourcePaths(): { relayScript: string; shimDir: string } {
  if (!app.isPackaged) {
    return { relayScript: path.join(app.getAppPath(), 'scripts', 'crew-mcp.js'), shimDir: path.join(app.getAppPath(), 'resources', 'crew', 'gh-shim') };
  }
  return {
    relayScript: path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'scripts', 'crew-mcp.js'),
    shimDir: path.join(process.resourcesPath, 'crew', 'gh-shim'),
  };
}

function hireRepos(hireId: string): string[] {
  const row = getDatabase().prepare(`SELECT data FROM crew_hire_cache WHERE hire_id = ?`).get(hireId) as { data: string } | undefined;
  try {
    const repos = (JSON.parse(row?.data ?? '{}') as { repos?: unknown }).repos;
    return Array.isArray(repos) ? repos.filter((r): r is string => typeof r === 'string').map((r) => r.toLowerCase()) : [];
  } catch {
    return [];
  }
}

function ensureServices(): RunServiceManager {
  const db = getDatabase();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  host ??= new McpHost(db, hostSocketPath(app.getPath('userData')));
  gateway ??= new GithubGateway({
    db,
    requestToken: (jobId, id, requestedBy, repos) => runtimeHub?.sendTokenRequest(jobId, id, requestedBy, repos) ?? false,
    run: runGh(ghPath()),
  });
  const gw = gateway;
  services ??= new RunServiceManager({
    host,
    broker: () => runtime?.broker ?? null,
    tools: (job, threadKey) => crewTools(crewToolDeps(db), job, threadKey),
    gateway: gw,
    repos: hireRepos,
    uid,
    execPath: process.execPath,
    ...crewResourcePaths(),
  });
  return services;
}

function crewToolDeps(db: ReturnType<typeof getDatabase>): Parameters<typeof crewTools>[0] {
  return {
    db,
    raiseCard: (jobId, raise) => runtimeHub?.sendCard(jobId, raise) ?? false,
    sendMessage: (jobId, send) => runtimeHub?.sendMessage(jobId, send) ?? false,
    writeNote: (jobId, write) => runtimeHub?.sendNoteWrite(jobId, write) ?? false,
  };
}

/** On Windows every run is prepared inside BodhiCrew; nothing is built off Windows. */
function ensureWindowsCrew(signIn: CrewSignIn): WindowsCrew | null {
  if (process.platform !== 'win32') return null;
  if (windowsCrew) return windowsCrew;
  ensureServices();
  const db = getDatabase();
  const res = crewResourcePaths();
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'crew-agent') : path.join(app.getAppPath(), 'resources', 'crew-agent');
  windowsCrew = createWindowsCrew({
    db,
    signIn,
    accounts: getAllAccounts,
    host: host as McpHost,
    gateway: gateway as GithubGateway,
    broker: () => runtime?.broker ?? null,
    tools: (job, threadKey) => crewTools(crewToolDeps(db), job, threadKey),
    repos: hireRepos,
    onLost: (hireId) => runtime?.interrupt(hireId),
    handbook: (hireId) => handbookFor(db, hireId),
    skills: (hireId) => pinnedSkills(db, hireId),
    timeZone: () => machineTimeZone(),
    audit: (event, detail) => writeAudit(db, null, event, detail),
    openExternal: (url) => void shell.openExternal(url),
    belongsTo: (accountId, _token, accountUuid) => {
      const known = getAllAccounts().find((a) => a.id === accountId);
      const windowsUuid = known ? resolveAccountIdentity(known.configDir).accountUuid : null;
      return known !== undefined && accountUuid !== null && accountUuid === windowsUuid;
    },
    resources: { dir, relayScript: res.relayScript, shimDir: res.shimDir },
    recordsFile: path.join(app.getPath('userData'), 'crew', 'wsl-tmp.json'),
    ...windowsSetupDeps(async () => {
      await runtime?.loop.tick();
    }),
  });
  return windowsCrew;
}

const realDir = (file: string): string => {
  try {
    return path.dirname(fs.realpathSync(file));
  } catch {
    return path.dirname(file);
  }
};

function reopenedForRuns(): string[] {
  const exec = process.execPath;
  const bundle = exec.includes('.app/') ? exec.slice(0, exec.indexOf('.app/') + 4) : path.dirname(exec);
  return [bundle, app.getAppPath(), crewResourcePaths().shimDir, realDir(claudePath())];
}

export function crewPrepareDeps(signIn: CrewSignIn): PrepareDeps {
  const userData = app.getPath('userData');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return {
    windows: ensureWindowsCrew(signIn)?.windows,
    db: getDatabase(),
    signIn,
    accounts: getAllAccounts,
    loggedIn: (dir) => resolveAccountIdentity(dir).loggedIn,
    userData,
    home: os.homedir(),
    claudePath: claudePath(),
    env: process.env,
    timeZone: () => machineTimeZone(),
    handbook: (hireId) => handbookFor(getDatabase(), hireId),
    restoreSkills: (paths, hireId) => restoreSkills(paths, pinnedSkills(getDatabase(), hireId)),
    holds,
    usage: getUsage,
    accountCap: getCrewAccountCap,
    hireUsage: new HireDayUsage(getDatabase(), async (hireId, epoch, since) => {
      const frame = await runtimeHub?.usageRead(hireId, epoch, since);
      return frame ? frame.inputTokens + frame.cacheCreationTokens + frame.outputTokens : null;
    }),
    services: async (job, threadKey, runId) => {
      const manager = ensureServices();
      if (!(await host?.ready())) throw new ServicesNotReady('the Crew MCP host is not listening');
      return manager.start(job, threadKey, runId);
    },
    sandbox: () => ({
      accountDirs: getAllAccounts().map((a) => a.configDir),
      userDataEntries: listDir(userData),
      crewEntries: listDir(path.join(userData, 'crew')),
      sockets: [],
      socketRoot: `/tmp/cr-${uid}`,
      allowedDomains: [],
      reopen: reopenedForRuns(),
      listDir,
    }),
  };
}

function attach(hub: HubClient): CrewRuntime {
  runtime?.stop();
  detachHub?.();
  const db = getDatabase();
  const signIn = new CrewSignIn(db, safeStorage);
  const prepareDeps = crewPrepareDeps(signIn);
  runtimeHub = hub;
  runtime = startCrewRuntime({
    db,
    hub,
    signIn,
    holds,
    slots,
    settled: () => {
      runtime?.loop.tick().catch((err) => log.warn('[Crew] could not pick up the next job', err));
    },
    accounts: getAllAccounts,
    prepare: (job: CrewJob, threadKey: string, runId: string): Promise<Prepared> =>
      prepareRun(prepareDeps, job, threadKey, runId),
    runEnded: (jobId) => {
      services?.end(jobId);
      windowsCrew?.end(jobId);
    },
    usage: { get: getUsage, set: setUsage },
    loggedIn: (account) => resolveAccountIdentity(account.configDir).loggedIn,
    remind: (reminder, account) => {
      try {
        new Notification({ title: 'Bodhi Crew', body: reminderText(reminder, account.label) }).show();
      } catch (err) {
        log.warn('[Crew] could not show a sign-in reminder', err);
      }
    },
    schedule: {
      hub,
      machineId: () => getPreference(MACHINE_ID_PREF),
      tellOwner: tellOwnerHere,
    },
    home: crewHomeDeps(hub, signIn),
  });
  const onToken = (frame: TokenFrame) => gateway?.onToken(frame);
  const onRefused = (frame: RefusedFrame) => gateway?.onRefused(frame.id);
  hub.on('token', onToken);
  hub.on('refused', onRefused);
  detachHub = () => {
    hub.off('token', onToken);
    hub.off('refused', onRefused);
  };
  return runtime;
}

export function startCrew(): CrewRuntime {
  sweepLetGo(app.getPath('userData'), Date.now());
  if (process.platform !== 'win32') {
    try {
      reapLeftoverRuns(getDatabase(), systemReap);
      sweepRunDirs(socketRoot(process.getuid?.() ?? 0), process.getuid?.() ?? 0);
    } catch (err) {
      log.error('[Crew] could not end leftover runs', err);
    }
  }
  setCrewHubReplaced((hub) => attach(hub));
  setCrewInterrupt((hireId) => runtime?.interrupt(hireId));
  const hub = startCrewHub();
  return runtime && runtimeHub === hub ? runtime : attach(hub);
}

/** Sign in for Crew on Windows; null off Windows or before Crew has started. */
export function crewWindowsSignIn(): WindowsCrew['signIn'] | null {
  return windowsCrew?.signIn ?? null;
}

/** The Windows setup screen's service; null off Windows or before Crew has started. */
export function crewWindowsSetup(): WindowsCrew['setup'] | null {
  return windowsCrew?.setup ?? null;
}

/** After Repair: the full check again, interop included, then held runs try again. */
export async function crewWindowsRepaired(): Promise<void> {
  await windowsCrew?.afterRepair();
  if (runtime) void runtime.loop.tick();
}

export function stopCrew(): void {
  setCrewHubReplaced(null);
  runtime?.stop();
  detachHub?.();
  detachHub = null;
  services?.endAll();
  windowsCrew?.endAll();
  windowsCrew = null;
  gateway?.stop();
  host?.close();
  services = null;
  gateway = null;
  host = null;
  runtime = null;
  runtimeHub = null;
  setCrewInterrupt(null);
  stopCrewHub();
}

/** A fresh login for the account: its auth-failure hold lifts and held runs try again. */
export function crewRecordSignIn(accountId: string, now = Date.now()): void {
  new CrewSignIn(getDatabase(), safeStorage).recordSignIn(accountId, now);
  if (runtime) void runtime.loop.tick();
}

export function crewRuntime(): CrewRuntime | null {
  return getCrewHub() ? runtime : null;
}
