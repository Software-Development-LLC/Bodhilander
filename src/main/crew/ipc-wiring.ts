/**
 * The Crew IPC channels joined to the running Hub client and runtime.
 * The stubs below are owed by the main side and answer "not available" until then.
 */
import log from 'electron-log';
import type { CrewCardList, CrewEditResult, CrewLinkView } from '../../shared/types';
import { getDatabase } from '../database';
import { getAllAccounts } from '../repositories/accounts';
import { getPreference } from '../repositories/preferences';
import { resolveAccountRef } from './account-ref';
import { crewRuntime } from './crew-main';
import { MACHINE_ID_PREF, type HubClient } from './hub-client';
import type { LinkFlow } from './hub-link';
import { getCrewHub, newLinkFlow } from './hub-service';
import { crewStatusFrom, KEYCHAIN_NEEDED, linkViewFrom, registerCrewIpc } from './ipc';
import type { UsageFrame } from './protocol';

/** Owed: send `usage_read` for the hire and resolve with the Hub's `usage` answer, or null on timeout. */
export async function hubUsageRead(_hub: HubClient, _hireId: string, _epoch: number, _since: number): Promise<UsageFrame | null> {
  return null;
}

/** Owed: the cards this machine raised, with any decision delivered for them. */
export function hubCards(): CrewCardList {
  return null;
}

/** Owed: open the card where it is decided. */
export function openHubCard(_raiseId: string): boolean {
  return false;
}

/** Owed: tell the Hub, then move the hire folder aside. */
export async function letGoHire(_hireId: string): Promise<CrewEditResult> {
  return { ok: false, error: "Let go isn't available on this machine yet." };
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
