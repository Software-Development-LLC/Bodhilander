/**
 * Sealing a transfer bundle for the trip through the relay, which is a courier
 * here exactly as it is for terminal traffic. Same AEAD, reached through the
 * same `seal`/`open`, so there is one implementation rather than two.
 */

import { open, seal, type SealedFrame } from '../api/relay/e2e';
import { deriveHandoffKey, generateRecoveryPhrase } from './recovery-phrase';

const MAGIC = Buffer.from('BDHLHOFF', 'ascii');
export const HANDOFF_FORMAT_VERSION = 1;

/** Magic, version byte and the GCM tag — what sealing adds to a bundle. */
export const HANDOFF_SEAL_OVERHEAD_BYTES = MAGIC.length + 1 + 16;

/**
 * Fixed at zero: the key comes from a phrase generated for this one bundle and
 * never reused, so the (key, nonce) pair cannot repeat.
 */
const NONCE_COUNTER = 0;

export interface SealedHandoff {
  bytes: Buffer;
  /** Shown to the user once. Without it the bytes are unrecoverable. */
  phrase: string;
}

export function sealHandoff(plaintext: Buffer): SealedHandoff {
  const phrase = generateRecoveryPhrase();
  const frame = seal(deriveHandoffKey(phrase), NONCE_COUNTER, plaintext);
  const version = Buffer.from([HANDOFF_FORMAT_VERSION]);
  return { bytes: Buffer.concat([MAGIC, version, Buffer.from(frame.ct, 'base64')]), phrase };
}

/**
 * Open a sealed handoff. A phrase that is not a phrase throws
 * `RecoveryPhraseError` from the checksum before these bytes are touched;
 * everything reaching the AEAD below is a phrase that could have been issued.
 */
export function openHandoff(sealed: Buffer, phrase: string): Buffer {
  const key = deriveHandoffKey(phrase);
  const header = MAGIC.length + 1;
  if (sealed.length <= header || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('This is not a Bodhilander handoff bundle.');
  }
  const version = sealed[MAGIC.length];
  if (version !== HANDOFF_FORMAT_VERSION) {
    throw new Error(`This handoff was prepared by a newer version of Bodhilander (format ${version}).`);
  }

  const frame: SealedFrame = { n: NONCE_COUNTER, ct: sealed.subarray(header).toString('base64') };
  try {
    return open(key, frame);
  } catch {
    throw new Error('That recovery phrase does not open this bundle. Check it against the other machine.');
  }
}
