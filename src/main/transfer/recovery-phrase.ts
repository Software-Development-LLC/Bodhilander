/**
 * The phrase that unlocks a handoff: generated, never chosen — a person's
 * choice is an offline guessing game whoever holds the ciphertext wins.
 * Sixteen words carry 128 bits a byte each; two checksum words follow.
 */

import crypto from 'crypto';

/** Bytes of key material the phrase carries. */
export const PHRASE_ENTROPY_BYTES = 16;
/** SHA-256 prefix appended so a mistyped phrase is caught before decryption. */
export const PHRASE_CHECKSUM_BYTES = 2;
export const PHRASE_WORD_COUNT = PHRASE_ENTROPY_BYTES + PHRASE_CHECKSUM_BYTES;

const HKDF_SALT = 'bodhilander-handoff-salt:v1';
const HKDF_INFO = 'bodhilander-handoff-key:v1';

/**
 * One word per byte value. No word is a prefix of another and no two are one
 * edit apart, so the common transcription slips change a byte outright and the
 * checksum sees them.
 */
export const PHRASE_WORDS: readonly string[] = [
  'agent', 'album', 'alloy', 'amber', 'anchor', 'angle', 'apple', 'apron',
  'arena', 'arrow', 'aspen', 'atlas', 'bacon', 'badge', 'bagel', 'baker',
  'banjo', 'basil', 'batch', 'beach', 'berry', 'birch', 'bison', 'cabin',
  'cable', 'cactus', 'camel', 'canal', 'candle', 'canoe', 'canvas', 'canyon',
  'cargo', 'carrot', 'castle', 'cedar', 'daisy', 'dance', 'dapper', 'dawn',
  'debate', 'decade', 'decoy', 'delta', 'denim', 'desert', 'dimple', 'donkey',
  'dragon', 'dune', 'eagle', 'early', 'earth', 'easel', 'echo', 'eight',
  'elbow', 'elder', 'elope', 'emblem', 'empire', 'engine', 'ethnic', 'fabric',
  'falcon', 'family', 'famous', 'fancy', 'feast', 'fever', 'fiber', 'fiddle',
  'finch', 'forest', 'fossil', 'gadget', 'galaxy', 'gallon', 'garden', 'garlic',
  'gauge', 'gavel', 'gecko', 'gentle', 'ginger', 'glass', 'globe', 'gnome',
  'habit', 'hamlet', 'hammer', 'harbor', 'hazel', 'heart', 'hedge', 'helmet',
  'herbal', 'hollow', 'honey', 'hotel', 'humble', 'icon', 'igloo', 'image',
  'index', 'indigo', 'ingot', 'inlet', 'input', 'ivory', 'jacket', 'jaguar',
  'jazz', 'jelly', 'jewel', 'jockey', 'jungle', 'junior', 'kayak', 'kelp',
  'kernel', 'kettle', 'kite', 'kitten', 'knee', 'koala', 'kudos', 'label',
  'ladder', 'lagoon', 'lamp', 'laser', 'lava', 'lemon', 'lilac', 'lunar',
  'magnet', 'mango', 'maple', 'marble', 'marine', 'market', 'marvel', 'meadow',
  'medal', 'melon', 'mirror', 'nacho', 'napkin', 'nature', 'nectar', 'needle',
  'nephew', 'nickel', 'nimble', 'noble', 'noodle', 'nugget', 'oasis', 'oblong',
  'ocean', 'octave', 'office', 'olive', 'onion', 'orbit', 'otter', 'oxygen',
  'pace', 'pearl', 'pebble', 'pencil', 'pepper', 'petal', 'piano', 'pilot',
  'pirate', 'pixel', 'plank', 'plaza', 'quail', 'quartz', 'quilt', 'quiver',
  'quote', 'rabbit', 'radar', 'raft', 'rally', 'ranch', 'rapid', 'raven',
  'ribbon', 'ridge', 'rocket', 'roster', 'runner', 'saddle', 'safari', 'sailor',
  'salmon', 'sample', 'sandal', 'satin', 'scarf', 'school', 'scout', 'shadow',
  'shovel', 'tablet', 'tackle', 'talent', 'tandem', 'target', 'tavern', 'teapot',
  'temple', 'tender', 'ultra', 'unit', 'upbeat', 'upper', 'urban', 'useful',
  'usher', 'vacuum', 'valley', 'vault', 'velvet', 'vendor', 'venue', 'violet',
  'violin', 'vivid', 'waffle', 'wagon', 'walnut', 'walrus', 'wander', 'wasp',
  'water', 'whale', 'wheat', 'xenon', 'yacht', 'yarn', 'yellow', 'yield',
  'yodel', 'yogurt', 'zebra', 'zenith', 'zephyr', 'zigzag', 'zinc', 'zone',
];

const INDEX_BY_WORD = new Map(PHRASE_WORDS.map((word, i) => [word, i]));

export type RecoveryPhraseProblem = 'length' | 'unknown-word' | 'checksum';

/** A phrase that cannot be a phrase, told apart from a bundle that will not open. */
export class RecoveryPhraseError extends Error {
  override name = 'RecoveryPhraseError';
  constructor(readonly problem: RecoveryPhraseProblem, message: string) {
    super(message);
  }
}

function checksum(entropy: Buffer): Buffer {
  return crypto.createHash('sha256').update(entropy).digest().subarray(0, PHRASE_CHECKSUM_BYTES);
}

function toPhrase(entropy: Buffer): string {
  const bytes = Buffer.concat([entropy, checksum(entropy)]);
  return [...bytes].map((b) => PHRASE_WORDS[b]!).join(' ');
}

/** A fresh phrase, and with it a fresh key. Never reuse one across bundles. */
export function generateRecoveryPhrase(): string {
  return toPhrase(crypto.randomBytes(PHRASE_ENTROPY_BYTES));
}

/** Split on any run of whitespace, commas or dashes, so paper transcription is forgiving. */
export function splitRecoveryPhrase(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 0);
}

/**
 * The entropy behind a phrase. Throws `RecoveryPhraseError` naming what is
 * wrong — nothing here touches a bundle, so a refusal costs the stored one
 * nothing.
 */
export function decodeRecoveryPhrase(phrase: string): Buffer {
  const words = splitRecoveryPhrase(phrase);
  if (words.length !== PHRASE_WORD_COUNT) {
    throw new RecoveryPhraseError(
      'length',
      `A recovery phrase is ${PHRASE_WORD_COUNT} words; this one has ${words.length}.`,
    );
  }

  const bytes = Buffer.alloc(PHRASE_WORD_COUNT);
  for (const [i, word] of words.entries()) {
    const index = INDEX_BY_WORD.get(word);
    if (index === undefined) {
      throw new RecoveryPhraseError('unknown-word', `"${word}" is not a recovery phrase word.`);
    }
    bytes[i] = index;
  }

  const entropy = bytes.subarray(0, PHRASE_ENTROPY_BYTES);
  if (!checksum(entropy).equals(bytes.subarray(PHRASE_ENTROPY_BYTES))) {
    throw new RecoveryPhraseError('checksum', 'That recovery phrase has a typo in it — check the words and try again.');
  }
  return Buffer.from(entropy);
}

/**
 * The bundle key for a phrase. HKDF rather than a password hash on purpose:
 * the input is 128 CSPRNG bits, so there is no dictionary to slow down, and a
 * deliberately slow derivation would only tax the person restoring.
 */
export function deriveHandoffKey(phrase: string): Buffer {
  const entropy = decodeRecoveryPhrase(phrase);
  return Buffer.from(crypto.hkdfSync('sha256', entropy, Buffer.from(HKDF_SALT), Buffer.from(HKDF_INFO), 32));
}
