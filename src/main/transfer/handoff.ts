/**
 * Carrying a transfer bundle between machines over the relay. Nothing here
 * knows Electron or the network — it takes a transport and a preference store
 * — and the restore is `restoreTransferBundle`, as the file picker reaches it.
 */

import type DatabaseCtor from 'better-sqlite3';
import type { HandoffOffer } from '../../shared/types';
import { buildTransferBundle, measureTranscriptBytes, type ExportOptions } from './bundle-export';
import { readBundleManifest, restoreTransferBundle, type ImportOptions, type ImportOutcome } from './bundle-import';
import type { TransferManifest } from './bundle-format';
import { formatBytes } from './bundle-format';
import { HANDOFF_SEAL_OVERHEAD_BYTES, openHandoff, sealHandoff } from './handoff-crypto';
import { deriveHandoffKey } from './recovery-phrase';

type Db = DatabaseCtor.Database;

export interface HandoffTransport {
  /** Sealed bytes into this user's relay slot, replacing anything already there. */
  upload(sealed: Buffer): Promise<HandoffOffer>;
  /** What is waiting, without pulling the bytes. */
  peek(): Promise<HandoffOffer | null>;
  download(): Promise<{ id: string; sealed: Buffer }>;
  /** Drop the bundle, now that this machine has restored from it. */
  acknowledge(handoffId: string): Promise<void>;
}

export interface PreferenceStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/**
 * The bundle this machine has already turned down. `relay.` because the answer
 * belongs to this machine and to the relay slot it was asked about — and
 * because that prefix is one an export leaves behind.
 */
export const DECLINED_HANDOFF_PREF = 'relay.declinedHandoffId';

export interface PreparedHandoff {
  offer: HandoffOffer;
  manifest: TransferManifest;
  /** Shown once. Nothing on this machine or the relay can reproduce it. */
  phrase: string;
  sealedBytes: number;
}

export interface PrepareOptions {
  transport: HandoffTransport;
  export: ExportOptions;
  /** Checked before the upload, so the refusal names a size rather than a 413. */
  maxBytes: number;
  /**
   * Asked once the bundle exists and its size is known, before anything
   * leaves the machine. Declining stops the handoff; nothing is uploaded.
   */
  confirm?: (byteLength: number, manifest: TransferManifest) => Promise<boolean>;
}

/**
 * How much better than raw gzip could plausibly do on transcript JSONL. Only a
 * hopeless state is refused on this estimate — the exact check still follows
 * the build — but it spares the operator minutes of work to earn a no.
 */
const PLAUSIBLE_COMPRESSION_CEILING = 20;

/** Null when the confirmation was declined; nothing reached the relay. */
export async function prepareHandoff(db: Db, options: PrepareOptions): Promise<PreparedHandoff | null> {
  const raw = measureTranscriptBytes(db, options.export.legacyConfigDir);
  if (raw > options.maxBytes * PLAUSIBLE_COMPRESSION_CEILING) {
    throw new Error(
      `This machine's conversation transcripts alone are ${formatBytes(raw)}, far past the ` +
        `${formatBytes(options.maxBytes)} the relay carries. Export it to a file instead.`,
    );
  }

  const { bytes, manifest } = buildTransferBundle(db, options.export);
  const sealedLength = bytes.length + HANDOFF_SEAL_OVERHEAD_BYTES;
  if (sealedLength > options.maxBytes) {
    throw new Error(
      `This machine's state is ${formatBytes(sealedLength)}, and the relay carries up to ` +
        `${formatBytes(options.maxBytes)}. Export it to a file instead.`,
    );
  }
  if (options.confirm && !(await options.confirm(bytes.length, manifest))) return null;

  const { bytes: sealed, phrase } = sealHandoff(bytes);
  const offer = await options.transport.upload(sealed);
  return { offer, manifest, phrase, sealedBytes: sealed.length };
}

export interface OpenedHandoff {
  handoffId: string;
  bytes: Buffer;
  manifest: TransferManifest | null;
}

/**
 * Pull and open the waiting bundle. The phrase is decoded first: a typo is
 * refused by its checksum before anything is downloaded, so a wrong phrase
 * never reaches — and so can never damage — what the relay is holding.
 */
export async function fetchHandoff(transport: HandoffTransport, phrase: string): Promise<OpenedHandoff> {
  deriveHandoffKey(phrase);
  const { id, sealed } = await transport.download();
  const bytes = openHandoff(sealed, phrase);
  return { handoffId: id, bytes, manifest: readBundleManifest(bytes) };
}

export interface ApplyOptions {
  transport: HandoffTransport;
  import: ImportOptions;
}

export interface AppliedHandoff {
  outcome: ImportOutcome;
  /** False when the restore landed but the relay is still holding the bundle. */
  acknowledged: boolean;
}

/**
 * Restore an opened handoff, then tell the relay to forget it. Once the import
 * has returned, nothing the relay says can make it not have happened — so the
 * acknowledgement is reported beside the outcome, never thrown over it.
 */
export async function applyHandoff(db: Db, opened: OpenedHandoff, options: ApplyOptions): Promise<AppliedHandoff> {
  const outcome = await restoreTransferBundle(db, opened.bytes, options.import);
  try {
    await options.transport.acknowledge(opened.handoffId);
    return { outcome, acknowledged: true };
  } catch {
    return { outcome, acknowledged: false };
  }
}

/** Remember that this exact bundle was turned down, so it stops being offered. */
export function declineHandoff(prefs: PreferenceStore, handoffId: string): void {
  prefs.set(DECLINED_HANDOFF_PREF, handoffId);
}

/**
 * Whether an offer has already been declined. Keyed on the bundle rather than
 * on the relay slot, so preparing a fresh handoff on the old machine produces
 * an offer this machine has not answered yet.
 */
export function isHandoffDeclined(prefs: PreferenceStore, handoffId: string): boolean {
  return prefs.get(DECLINED_HANDOFF_PREF) === handoffId;
}
