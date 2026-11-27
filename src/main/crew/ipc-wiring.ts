/** The Crew IPC channels joined to the running Hub client and runtime. */
import { randomUUID } from 'crypto';
import { app, safeStorage, shell } from 'electron';
import log from 'electron-log';
import type { CrewCardList, CrewEditResult, CrewHireAccount, CrewHireInput, CrewHireResult, CrewLinkView, CrewOfficeImportResult } from '../../shared/types';
import { getDatabase } from '../database';
import { getAllAccounts } from '../repositories/accounts';
import { getPreference } from '../repositories/preferences';
import { accountRefFor, resolveAccountRef } from './account-ref';
import { listCards } from './card-log';
import { crewHomeDeps, crewRuntime } from './crew-main';
import { makeHomeHere, unlinkHere } from './home';
import { MACHINE_ID_PREF, type HubClient } from './hub-client';
import type { LinkFlow } from './hub-link';
import { getCrewHub, newLinkFlow } from './hub-service';
import { resolveAccountIdentity } from '../account-identity';
import { CrewSignIn } from './crew-token';
import { createHire, HIRE_ANSWER_MS, hireAccounts, type HireDeps } from './hire';
import { crewStatusFrom, KEYCHAIN_NEEDED, linkViewFrom, registerCrewIpc } from './ipc';
import { LET_GO_ANSWER_MS, letGoHire as letGo, moveHireAside } from './let-go';
import type { EditResultFrame, UsageFrame } from './protocol';
import type { EditInput } from './sync';
import { findOfficeData, importFromOffice, officeEmployees, type EditOutcome } from './import-office';
import { cachedNote, parseNotePath } from './notes';
import { hirePaths } from './run/scope';

export function hubUsageRead(hub: HubClient, hireId: string, epoch: number, since: number): Promise<UsageFrame | null> {
  return hub.usageRead(hireId, epoch, since);
}

/** The cards this machine raised, from the local log; null when it cannot be read. */
export function hubCards(): CrewCardList {
  try {
    return listCards(getDatabase());
  } catch (err) {
    log.warn('[Crew] could not read the card log', err);
    return null;
  }
}

/** Cards are decided in Teams, and there is no deep link to one: open Teams itself. */
export function openHubCard(_raiseId: string): boolean {
  shell.openExternal('msteams:/').catch(() => shell.openExternal('https://teams.microsoft.com/').catch((err) => log.warn('[Crew] could not open Teams', err)));
  return true;
}

function editResultFrom(hub: HubClient, id: string, timeoutMs: number): Promise<EditResultFrame | null> {
  return new Promise((resolve) => {
    const onResult = (frame: EditResultFrame) => {
      if (frame.id !== id) return;
      clearTimeout(timer);
      hub.off('edit-result', onResult);
      resolve(frame);
    };
    const timer = setTimeout(() => {
      hub.off('edit-result', onResult);
      resolve(null);
    }, timeoutMs);
    hub.on('edit-result', onResult);
  });
}

/** Waits with no timeout for one edit's answer, for as long as this Hub client lives. */
function onLateEditResult(hub: HubClient, id: string, handle: (frame: EditResultFrame) => void): void {
  const onResult = (frame: EditResultFrame) => {
    if (frame.id !== id) return;
    hub.off('edit-result', onResult);
    try {
      handle(frame);
    } catch (err) {
      log.warn('[Crew] could not finish a late let go', err);
    }
  };
  hub.on('edit-result', onResult);
}

function accountChecks(): Pick<HireDeps, 'accounts' | 'refFor' | 'signedIn' | 'mode'> {
  const signIn = new CrewSignIn(getDatabase(), safeStorage);
  return {
    accounts: getAllAccounts,
    refFor: accountRefFor,
    signedIn: (account) => signIn.signedIn(account.id, resolveAccountIdentity(account.configDir).loggedIn, Date.now()),
    mode: () => signIn.mode(),
  };
}

export function hireAccountsHere(): CrewHireAccount[] {
  return hireAccounts(accountChecks());
}

export async function hireFromHere(input: CrewHireInput): Promise<CrewHireResult> {
  const hub = getCrewHub();
  if (!hub) return { ok: false, error: "Crew isn't running on this machine." };
  return createHire(
    {
      ...accountChecks(),
      db: getDatabase(),
      online: () => hub.getStatus() === 'online',
      sendEdit: (edit) => hub.sendEdit(edit),
      editResult: (id) => editResultFrom(hub, id, HIRE_ANSWER_MS),
    },
    input,
  );
}

function hireBody(hireId: string): Record<string, unknown> {
  const row = getDatabase().prepare(`SELECT data FROM crew_hire_cache WHERE hire_id = ?`).get(hireId) as { data: string } | undefined;
  try {
    return JSON.parse(row?.data ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Send an edit and wait for the Hub's answer to it. */
async function editAnswer(hub: HubClient, input: Omit<EditInput, 'id'>): Promise<EditOutcome> {
  const id = randomUUID();
  const answer = editResultFrom(hub, id, HIRE_ANSWER_MS);
  try {
    hub.sendEdit({ ...input, id });
  } catch (err) {
    log.warn('[Crew] could not queue an edit', err);
    return { ok: false, why: 'not queued' };
  }
  const frame = await answer;
  if (!frame) return { ok: false, why: 'no answer from Crew' };
  if (frame.result === 'applied') return { ok: true, objectId: frame.objectId };
  return { ok: false, why: frame.why ? `${frame.result}: ${frame.why}` : frame.result };
}

/** The bundle's hash as the Hub computed it; fetched when the cache has no body for it yet. */
function fetchedBundleHash(hub: HubClient, bundleId: string, timeoutMs: number): Promise<string | null> {
  const cached = (): string | null => {
    const hash = hub.cachedBody('skill_bundle', bundleId)?.hash;
    return typeof hash === 'string' && hash ? hash : null;
  };
  return new Promise((resolve) => {
    const done = (hash: string | null) => {
      clearTimeout(timer);
      hub.off('synced', onSynced);
      resolve(hash);
    };
    const onSynced = () => {
      const hash = cached();
      if (hash) done(hash);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    hub.on('synced', onSynced);
    hub.fetchObject({ kind: 'skill_bundle', objectId: bundleId });
  });
}

const pinEdit = (hub: HubClient, hireId: string, bundleId: string, hash: string): Promise<EditOutcome> =>
  editAnswer(hub, { op: 'update', kind: 'hire', objectId: hireId, hireId, fields: { skillBundleId: bundleId, skillBundleHash: hash } });

export async function pinSkillBundle(hireId: string, bundleId: string): Promise<CrewEditResult> {
  const hub = getCrewHub();
  if (!hub || hub.getStatus() !== 'online') return { ok: false, error: 'Crew is offline; try again once it reconnects.' };
  const hash = await fetchedBundleHash(hub, bundleId, HIRE_ANSWER_MS);
  if (!hash) return { ok: false, error: "That skill bundle hasn't reached this machine." };
  const pinned = await pinEdit(hub, hireId, bundleId, hash);
  return pinned.ok ? { ok: true } : { ok: false, error: `The pin was not applied (${pinned.why}).` };
}

export async function importOfficeHere(hireId: string, handle: string): Promise<CrewOfficeImportResult> {
  const hub = getCrewHub();
  const dataDir = findOfficeData(app.getPath('appData'));
  if (!hub || !dataDir) return { ok: false, error: "Crew or Office isn't on this machine." };
  const body = hireBody(hireId);
  if (body.homeMachineId !== getPreference(MACHINE_ID_PREF)) return { ok: false, error: 'Import on the home machine of this hire.' };
  const role = typeof body.roleId === 'string' ? body.roleId : '';
  const db = getDatabase();
  try {
    const summary = await importFromOffice(
      {
        createBundle: (id, bundleRole, files) => editAnswer(hub, { op: 'create', kind: 'skill_bundle', hireId: id, fields: { role: bundleRole, files } }),
        bundleHash: (bundleId) => fetchedBundleHash(hub, bundleId, HIRE_ANSWER_MS),
        pinBundle: (id, bundleId, hash) => pinEdit(hub, id, bundleId, hash),
        writeOwnerNote: (id, notePath, content) => {
          const where = parseNotePath(notePath);
          return !!where && hub.sendOwnerNote(id, notePath, cachedNote(db, id, where)?.rev ?? 0, content);
        },
      },
      { dataDir, handle, hireId, role, ownerDir: hirePaths(app.getPath('userData'), hireId).owner },
    );
    return { ok: true, ...summary };
  } catch (err) {
    log.warn('[Crew] the Office import failed', err);
    return { ok: false, error: 'The import stopped partway; see the log.' };
  }
}

export async function letGoHire(hireId: string): Promise<CrewEditResult> {
  const hub = getCrewHub();
  if (!hub) return { ok: false, error: "Crew isn't running on this machine." };
  return letGo(
    {
      online: () => hub.getStatus() === 'online',
      sendDelete: (id) => hub.sendEdit({ op: 'delete', kind: 'hire', objectId: id, hireId: id, fields: {} }),
      editResult: (id) => editResultFrom(hub, id, LET_GO_ANSWER_MS),
      onLateResult: (id, handle) => onLateEditResult(hub, id, handle),
      forget: (id) => hub.forgetHire(id),
      stop: (id) => crewRuntime()?.stopHire(id) ?? Promise.resolve(),
      moveAside: (id) => moveHireAside(app.getPath('userData'), id, Date.now()),
    },
    hireId,
  );
}

const CHANGE_EVENTS = ['status', 'synced', 'job', 'renewed', 'epoch', 'revoked', 'edit-result', 'lapsed', 'welcome'] as const;

const ACCOUNT_REFUSALS: Record<string, string> = {
  'unknown-account': "That account hasn't signed in, so Crew can't name it.",
  'hire-not-synced': 'This hire has not synced to this machine yet.',
  'send-failed': "The change couldn't be queued.",
};

export function wireCrewIpc(handle: (channel: string, handler: (...args: unknown[]) => unknown) => void, notify: () => void): void {
  let watched: HubClient | null = null;
  const onChange = () => notify();
  const hub = (): HubClient | null => {
    const current = getCrewHub();
    if (current !== watched) {
      for (const event of CHANGE_EVENTS) watched?.off(event, onChange);
      for (const event of CHANGE_EVENTS) current?.on(event, onChange);
      watched = current;
    }
    return current;
  };
  let link: LinkFlow | null = null;

  registerCrewIpc({
    handle,
    db: getDatabase,
    machineId: () => getPreference(MACHINE_ID_PREF),
    resolveAccount: (ref) => resolveAccountRef(ref, getAllAccounts()),
    accounts: getAllAccounts,
    status: () => {
      const client = hub();
      return crewStatusFrom(client?.getStatus() ?? null, client?.owner() ?? null, !!getPreference(MACHINE_ID_PREF));
    },
    online: () => hub()?.getStatus() === 'online',
    epochOf: (hireId) => hub()?.fence.known(hireId) ?? null,
    usageRead: (hireId, epoch, since) => {
      const client = hub();
      return client ? hubUsageRead(client, hireId, epoch, since) : Promise.resolve(null);
    },
    sendHireEdit: (hireId, fields) => {
      const client = hub();
      if (!client) return false;
      try {
        client.sendEdit({ op: 'update', kind: 'hire', objectId: hireId, hireId, fields });
        notify();
        return true;
      } catch (err) {
        log.warn('[Crew] could not queue a hire edit', err);
        return false;
      }
    },
    changeAccount: (hireId, accountId) => {
      const runtime = crewRuntime();
      const account = getAllAccounts().find((a) => a.id === accountId);
      if (!runtime || !account) return { ok: false, error: "Crew isn't running on this machine." };
      const outcome = runtime.changer.change(hireId, account);
      if ('refused' in outcome) return { ok: false, error: ACCOUNT_REFUSALS[outcome.refused] };
      notify();
      return { ok: true };
    },
    cards: hubCards,
    openCard: openHubCard,
    letGo: letGoHire,
    hireAccounts: hireAccountsHere,
    createHire: async (input) => {
      const result = await hireFromHere(input);
      notify();
      return result;
    },
    beginLink: async (): Promise<CrewLinkView> => {
      try {
        link = newLinkFlow();
      } catch (err) {
        log.warn('[Crew] no machine key for linking', err);
        return KEYCHAIN_NEEDED;
      }
      return linkViewFrom(await link.begin());
    },
    officeEmployees: () => {
      const dataDir = findOfficeData(app.getPath('appData'));
      return dataDir ? officeEmployees(dataDir) : null;
    },
    makeHome: (hireId) => {
      const client = hub();
      if (!client) return { ok: false, error: "Crew isn't running on this machine." };
      const result = makeHomeHere(crewHomeDeps(client, new CrewSignIn(getDatabase(), safeStorage)), hireId);
      notify();
      return result;
    },
    unlink: () => {
      const client = hub();
      if (!client) return { ok: false, error: "Crew isn't running on this machine." };
      return unlinkHere(crewHomeDeps(client, new CrewSignIn(getDatabase(), safeStorage)));
    },
    importFromOffice: (hireId, handle) => importOfficeHere(hireId, handle).finally(notify),
    pinSkillBundle: (hireId, bundleId) => pinSkillBundle(hireId, bundleId).finally(notify),
    confirmLinkOwner: (isMe) => {
      const confirmed = link?.confirmOwner(isMe) ?? false;
      link = null;
      notify();
      return confirmed;
    },
    now: Date.now,
  });
  hub();
}
