/**
 * Sealing a bundle for the relay to carry. What matters is what a wrong phrase
 * does: told apart from a corrupt bundle, and leaving the sealed bytes as they
 * were — they are the only copy the destination has.
 */
import { describe, expect, test } from 'bun:test';
import { HANDOFF_FORMAT_VERSION, openHandoff, sealHandoff } from '../handoff-crypto';
import { generateRecoveryPhrase, RecoveryPhraseError, splitRecoveryPhrase, PHRASE_WORDS } from '../recovery-phrase';

const PLAINTEXT = Buffer.from('BDHLBNDL — pretend this is a whole machine');

describe('sealing and opening', () => {
  test('round-trips the bundle under its own phrase', () => {
    const { bytes, phrase } = sealHandoff(PLAINTEXT);
    expect(openHandoff(bytes, phrase).equals(PLAINTEXT)).toBe(true);
  });

  test('produces bytes that are not the bundle', () => {
    const { bytes } = sealHandoff(PLAINTEXT);
    expect(bytes.includes(PLAINTEXT)).toBe(false);
    expect(bytes.subarray(0, 8).toString('ascii')).toBe('BDHLHOFF');
    expect(bytes[8]).toBe(HANDOFF_FORMAT_VERSION);
  });

  test('seals the same plaintext differently every time', () => {
    const first = sealHandoff(PLAINTEXT);
    const second = sealHandoff(PLAINTEXT);
    expect(first.bytes.equals(second.bytes)).toBe(false);
    expect(first.phrase).not.toBe(second.phrase);
  });
});

describe('a phrase that is not the right one', () => {
  test('is refused by the checksum before the bytes are touched', () => {
    const { bytes } = sealHandoff(PLAINTEXT);
    const before = Buffer.from(bytes);
    expect(() => openHandoff(bytes, 'not even close')).toThrow(RecoveryPhraseError);
    expect(bytes.equals(before)).toBe(true);
  });

  test('says so plainly when it is a well-formed phrase for another bundle', () => {
    const { bytes } = sealHandoff(PLAINTEXT);
    const before = Buffer.from(bytes);
    const other = generateRecoveryPhrase();
    expect(() => openHandoff(bytes, other)).toThrow(/recovery phrase does not open this bundle/);
    expect(bytes.equals(before)).toBe(true);
  });

  test('names the offending word rather than failing as a decryption error', () => {
    const { bytes, phrase } = sealHandoff(PLAINTEXT);
    const words = splitRecoveryPhrase(phrase);
    words[4] = 'quagmire';
    expect(() => openHandoff(bytes, words.join(' '))).toThrow(/quagmire/);
  });

  test('is distinguishable from a corrupt bundle', () => {
    const { bytes, phrase } = sealHandoff(PLAINTEXT);
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => openHandoff(tampered, phrase)).toThrow(/does not open this bundle/);

    const notABundle = Buffer.from('some other file entirely');
    expect(() => openHandoff(notABundle, phrase)).toThrow(/not a Bodhilander handoff bundle/);
  });

  test('refuses a container written by a newer build', () => {
    const { bytes, phrase } = sealHandoff(PLAINTEXT);
    const future = Buffer.from(bytes);
    future[8] = HANDOFF_FORMAT_VERSION + 1;
    expect(() => openHandoff(future, phrase)).toThrow(/newer version of Bodhilander/);
  });

  test('cannot be brute-forced a word at a time — one wrong word fails everything', () => {
    const { bytes, phrase } = sealHandoff(PLAINTEXT);
    const words = splitRecoveryPhrase(phrase);
    const wrong = PHRASE_WORDS.find((w) => w !== words[0])!;
    expect(() => openHandoff(bytes, [wrong, ...words.slice(1)].join(' '))).toThrow();
  });
});
