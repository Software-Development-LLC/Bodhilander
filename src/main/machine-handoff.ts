/**
 * "Move to another machine", over the relay instead of a file. The mechanics
 * live in `transfer/handoff`; this is the Electron half — the dialogs, the
 * app's database, and the relay client behind the transport.
 */

import { app, dialog } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import log from 'electron-log';
import { getDatabase } from './database';
import { legacyClaudeConfigDir } from './conversation-transcript';
import { getPreference, setPreference } from './repositories/preferences';
import { askRootMappings, registerRestoredAccountHooks } from './group-import-export';
import { recordArrival, suggestRootMappingsHere } from './arrival';
import type { RootSuggestion } from './transfer/root-suggest';
import { formatBytes, type TransferManifest } from './transfer/bundle-format';
import {
  applyHandoff,
  declineHandoff,
  fetchHandoff,
  isHandoffDeclined,
  prepareHandoff,
  type HandoffTransport,
} from './transfer/handoff';
import {
  HANDOFF_MAX_BYTES,
  type HandoffOfferState,
  type HandoffPrepareResult,
  type PortableImportResult,
} from '../shared/types';

const prefs = { get: getPreference, set: setPreference };

const NOT_LINKED = 'Link this machine to a relay account before moving it.';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function prepareMachineHandoff(
  transport: HandoffTransport | null,
  legacyDir: string = legacyClaudeConfigDir(),
): Promise<HandoffPrepareResult> {
  if (!transport) return { success: false, error: NOT_LINKED };
  try {
    const prepared = await prepareHandoff(getDatabase(), {
      transport,
      maxBytes: HANDOFF_MAX_BYTES,
      confirm: confirmHandoffUpload,
      export: {
        sourceAppVersion: app.getVersion(),
        sourcePlatform: process.platform,
        sourceUserData: app.getPath('userData'),
        legacyConfigDir: legacyDir,
      },
    });
    if (!prepared) return { success: false, error: 'Handoff cancelled' };
    log.info(`[Handoff] Prepared ${formatBytes(prepared.sealedBytes)} for another machine`);
    return {
      success: true,
      phrase: prepared.phrase,
      sizeLabel: formatBytes(prepared.sealedBytes),
      groupCount: prepared.manifest.counts.groups,
      sessionCount: prepared.manifest.counts.sessions,
      expiresAt: prepared.offer.expiresAt,
    };
  } catch (error) {
    log.error('[Handoff] Prepare failed:', message(error));
    return { success: false, error: message(error) };
  }
}

/**
 * What this machine should do about a waiting handoff. Errors are swallowed
 * into "nothing waiting": this runs on launch, and a relay that is unreachable
 * is not something to interrupt someone with.
 */
/**
 * The name of the machine whose offer was last read. Kept so the arrival
 * report can say where the state came from without a second signed round trip
 * for a label — an offer is always read before it can be restored, since
 * reading it is what puts the prompt on screen.
 */
let lastOfferedBy: string | null = null;

export async function readHandoffOffer(transport: HandoffTransport | null): Promise<HandoffOfferState> {
  if (!transport) return { offer: null, declined: false };
  try {
    const offer = await transport.peek();
    if (!offer) return { offer: null, declined: false };
    lastOfferedBy = offer.sourceMachineName ?? null;
    return { offer, declined: isHandoffDeclined(prefs, offer.id), sizeLabel: formatBytes(offer.byteSize) };
  } catch (error) {
    log.info('[Handoff] No offer available:', message(error));
    return { offer: null, declined: false };
  }
}

export function declineMachineHandoff(transport: HandoffTransport | null, handoffId: string): void {
  if (!transport) {
    // Unlinked since the offer was drawn, so what is on screen is stale.
    // Writing the decline here would permanently bury a bundle that is real.
    log.info('[Handoff] Declined a stale offer; not recording it');
    return;
  }
  declineHandoff(prefs, handoffId);
  log.info('[Handoff] Offer declined; it will not be raised again');
}

/**
 * What this machine proposes for the source's roots. Injectable because the
 * real one walks the user's home directory: a test that did not control it
 * would depend on whatever happens to be on the machine running it, and would
 * ask a different question depending on the answer.
 */
export type RootSuggester = (roots: string[]) => RootSuggestion[];

export async function restoreMachineHandoff(
  transport: HandoffTransport | null,
  phrase: string,
  legacyDir: string = legacyClaudeConfigDir(),
  suggest: RootSuggester = suggestRootMappingsHere,
): Promise<PortableImportResult> {
  if (!transport) return { success: false, error: NOT_LINKED };
  let opened;
  try {
    opened = await fetchHandoff(transport, phrase);
  } catch (error) {
    // Nothing has been changed and nothing consumed — the bundle is still
    // there for another attempt.
    log.warn('[Handoff] Could not open the waiting bundle:', message(error));
    return { success: false, error: message(error) };
  }

  const roots = opened.manifest?.workingDirRoots ?? [];
  const mappings = await askRootMappings(roots, suggest(roots));
  if (mappings === null) return { success: false, error: 'Import cancelled' };

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhilander-handoff-'));
  try {
    const { outcome, acknowledged } = await applyHandoff(getDatabase(), opened, {
      transport,
      import: {
        accountsRoot: path.join(app.getPath('userData'), 'claude-accounts'),
        legacyConfigDir: legacyDir,
        stagingDir,
        mappings,
      },
    });
    registerRestoredAccountHooks();
    recordArrival({ via: 'handoff', sourceLabel: lastOfferedBy, manifest: outcome.manifest, outcome });
    if (!acknowledged) {
      // Restored, but the relay still holds the bundle and would offer it
      // again on the next launch. Answering it here is what stops that.
      declineHandoff(prefs, opened.handoffId);
      log.warn('[Handoff] Restored, but the relay would not release the bundle; it expires on its own');
    }
    log.info(
      `[Handoff] Restored ${outcome.groups} group(s), ${outcome.sessions} session(s), ` +
        `${outcome.transcripts} transcript(s); ${outcome.needsRelink.length} need relinking`,
    );
    return {
      success: true,
      groupCount: outcome.groups,
      sessionCount: outcome.sessions,
      skippedGroups: outcome.skippedGroups,
      skippedSessions: outcome.skippedSessions,
      transcriptCount: outcome.transcripts,
      needsRelinkCount: outcome.needsRelink.length,
    };
  } catch (error) {
    log.error('[Handoff] Restore failed:', message(error));
    return { success: false, error: message(error) };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** The one confirmation the old machine sees before its state leaves it. */
async function confirmHandoffUpload(byteLength: number, manifest: TransferManifest): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Prepare Handoff', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Send to Another Machine',
    message: `Send ${formatBytes(byteLength)} of this machine's state to the relay?`,
    detail:
      `${manifest.counts.groups} group(s), ${manifest.counts.sessions} session(s), ` +
      `${manifest.counts.transcripts} conversation transcript(s), ` +
      `${manifest.counts.accounts} account(s), ${manifest.counts.preferences} setting(s).\n\n` +
      'It is encrypted here first. The relay stores the result and cannot read it, and only the ' +
      'recovery phrase shown next can open it. This machine keeps everything it has; nothing is ' +
      'removed. API keys, Teams tokens and the relay identity stay here — the new machine signs ' +
      'in for itself.',
  });
  return response === 0;
}
