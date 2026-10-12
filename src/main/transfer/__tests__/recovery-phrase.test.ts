/**
 * The phrase a handoff hangs on. A duplicate or a near-miss in the wordlist
 * would quietly cost entropy or defeat the checksum, and the checksum has one
 * job: refuse a mistyped phrase here, before anything has been downloaded.
 */
import { describe, expect, test } from 'bun:test';
import {
  decodeRecoveryPhrase,
  deriveHandoffKey,
  generateRecoveryPhrase,
  PHRASE_ENTROPY_BYTES,
  PHRASE_WORDS,
  PHRASE_WORD_COUNT,
  RecoveryPhraseError,
  splitRecoveryPhrase,
} from '../recovery-phrase';

function problemOf(phrase: string): string {
  try {
    decodeRecoveryPhrase(phrase);
  } catch (err) {
    if (err instanceof RecoveryPhraseError) return err.problem;
    return `unexpected: ${String(err)}`;
  }
  return 'accepted';
}

describe('the wordlist', () => {
  test('is exactly one word per byte value, all distinct', () => {
    expect(PHRASE_WORDS).toHaveLength(256);
    expect(new Set(PHRASE_WORDS).size).toBe(256);
  });

  test('is lowercase letters only, so transcription has one spelling', () => {
    expect(PHRASE_WORDS.filter((w) => !/^[a-z]{3,7}$/.test(w))).toEqual([]);
  });

  test('holds no word that is a prefix of another', () => {
    const sorted = [...PHRASE_WORDS].sort();
    const collisions = sorted.filter((word, i) => i > 0 && word.startsWith(sorted[i - 1]!));
    expect(collisions).toEqual([]);
  });

  test('holds no two words one edit apart', () => {
    const oneEdit = (a: string, b: string): boolean => {
      if (a.length === b.length) return a.split('').filter((c, i) => c !== b[i]).length === 1;
      if (Math.abs(a.length - b.length) !== 1) return false;
      const [short, long] = a.length < b.length ? [a, b] : [b, a];
      return [...long].some((_, i) => long.slice(0, i) + long.slice(i + 1) === short);
    };
    const pairs = PHRASE_WORDS.flatMap((a, i) => PHRASE_WORDS.slice(i + 1).filter((b) => oneEdit(a, b)).map((b) => [a, b]));
    expect(pairs).toEqual([]);
  });
});

describe('generating a phrase', () => {
  test('produces the fixed word count and decodes to its entropy', () => {
    const phrase = generateRecoveryPhrase();
    expect(splitRecoveryPhrase(phrase)).toHaveLength(PHRASE_WORD_COUNT);
    expect(decodeRecoveryPhrase(phrase)).toHaveLength(PHRASE_ENTROPY_BYTES);
  });

  test('never repeats, so a key is never reused across bundles', () => {
    const phrases = new Set(Array.from({ length: 50 }, () => generateRecoveryPhrase()));
    expect(phrases.size).toBe(50);
  });

  test('derives the same key every time, and a different key per phrase', () => {
    const a = generateRecoveryPhrase();
    const b = generateRecoveryPhrase();
    expect(deriveHandoffKey(a)).toHaveLength(32);
    expect(deriveHandoffKey(a).equals(deriveHandoffKey(a))).toBe(true);
    expect(deriveHandoffKey(a).equals(deriveHandoffKey(b))).toBe(false);
  });

  test('is read back through casing, line breaks and stray punctuation', () => {
    const phrase = generateRecoveryPhrase();
    const messy = phrase.toUpperCase().split(' ').join(',\n  ');
    expect(deriveHandoffKey(messy).equals(deriveHandoffKey(phrase))).toBe(true);
  });
});

describe('refusing a phrase that was mistyped', () => {
  test('names the count when there are too few or too many words', () => {
    const words = splitRecoveryPhrase(generateRecoveryPhrase());
    expect(problemOf(words.slice(0, -1).join(' '))).toBe('length');
    expect(problemOf([...words, words[0]!].join(' '))).toBe('length');
  });

  test('names a word that is not in the list', () => {
    const words = splitRecoveryPhrase(generateRecoveryPhrase());
    words[3] = 'sasquatch';
    expect(() => decodeRecoveryPhrase(words.join(' '))).toThrow(/sasquatch/);
    expect(problemOf(words.join(' '))).toBe('unknown-word');
  });

  test('catches one entropy word swapped for another', () => {
    const words = splitRecoveryPhrase(generateRecoveryPhrase());
    // Any word other than the one already there changes a byte of the entropy.
    words[0] = PHRASE_WORDS.find((w) => w !== words[0])!;
    expect(problemOf(words.join(' '))).toBe('checksum');
  });

  test('catches two words transposed', () => {
    let words = splitRecoveryPhrase(generateRecoveryPhrase());
    while (words[2] === words[5]) words = splitRecoveryPhrase(generateRecoveryPhrase());
    [words[2], words[5]] = [words[5]!, words[2]!];
    expect(problemOf(words.join(' '))).toBe('checksum');
  });

  test('catches a corrupted checksum word', () => {
    const words = splitRecoveryPhrase(generateRecoveryPhrase());
    const last = PHRASE_WORD_COUNT - 1;
    words[last] = PHRASE_WORDS.find((w) => w !== words[last])!;
    expect(problemOf(words.join(' '))).toBe('checksum');
  });
});
