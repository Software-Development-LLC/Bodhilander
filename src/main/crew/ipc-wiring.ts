/** The Crew IPC channels joined to the running Hub client and runtime. */
import { app, shell } from 'electron';
import log from 'electron-log';
import type { CrewCardList, CrewEditResult, CrewHireInput, CrewHireResult, CrewLinkView } from '../../shared/types';
import { getDatabase } from '../database';
import { getAllAccounts } from '../repositories/accounts';
import { getPreference } from '../repositories/preferences';
import { accountRefFor, resolveAccountRef } from './account-ref';
import { listCards } from './card-log';
import { crewRuntime } from './crew-main';
import { MACHINE_ID_PREF, type HubClient } from './hub-client';
import type { LinkFlow } from './hub-link';
import { getCrewHub, newLinkFlow } from './hub-service';
import { createHire, HIRE_ANSWER_MS } from './hire';
import { crewStatusFrom, KEYCHAIN_NEEDED, linkViewFrom, registerCrewIpc } from './ipc';
import { LET_GO_ANSWER_MS, letGoHire as letGo, moveHireAside } from './let-go';
import type { EditResultFrame, UsageFrame } from './protocol';

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

export async function hireFromHere(input: CrewHireInput): Promise<CrewHireResult> {
  const hub = getCrewHub();
  if (!hub) return { ok: false, error: "Crew isn't running on this machine." };
  return createHire(
    {
      db: getDatabase(),
      online: () => hub.getStatus() === 'online',
      accounts: getAllAccounts,
      refFor: accountRefFor,
      sendEdit: (edit) => hub.sendEdit(edit),
      editResult: (id) => editResultFrom(hub, id, HIRE_ANSWER_MS),
    },
    input,
  );
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
