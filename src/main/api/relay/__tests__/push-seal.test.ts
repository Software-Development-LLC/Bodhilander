/**
 * Web-push payload sealing on the agent.
 */

// The first test is the one that matters: it reproduces the worked example in
// RFC 8291 §5 byte for byte. Everything else here is self-consistent, and a
// matching pair of mistakes would sail through all of it. The RFC vector is an
// answer nobody here chose, so agreeing with it is evidence a browser can read
// what we send.
import { describe, expect, test } from 'bun:test';
import { createDecipheriv, createECDH, hkdfSync } from 'crypto';
import { MAX_PLAINTEXT_BYTES, PushSealError, RECORD_SIZE, sealWebPushPayload } from '../push-seal';

const b64 = (s: string) => Buffer.from(s, 'base64url');

/** RFC 8291 §5 — "Push Message Encryption Example". */
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  senderPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
} as const;

/** A throwaway subscription: a real P-256 keypair and 16 random-ish auth bytes. */
function makeSubscription(auth = Buffer.alloc(16, 5)) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    privateKey: ecdh.getPrivateKey(),
    publicKey: ecdh.getPublicKey(),
  };
}

/**
 * The receiving half of RFC 8291, from the browser's point of view. It derives
 * from the RECEIVER's key and reads the sender's out of the record header, so
 * it cannot inherit a mistake from the encrypt path's own inputs.
 */
function openSealed(body: Buffer, receiverPrivate: Buffer, receiverPublic: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  expect(recordSize).toBe(RECORD_SIZE);
  expect(idLength).toBe(65);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(receiverPrivate);
  const shared = ecdh.computeSecret(senderPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // Strip the record delimiter the sender appended.
  expect(padded[padded.length - 1]).toBe(0x02);
  return padded.subarray(0, padded.length - 1).toString('utf8');
}

describe('sealWebPushPayload', () => {
  test('reproduces the RFC 8291 §5 example byte for byte', () => {
    const sealed = sealWebPushPayload(
      { p256dh: RFC8291.receiverPublic, auth: RFC8291.authSecret },
      RFC8291.plaintext,
      { salt: b64(RFC8291.salt), senderPrivateKey: b64(RFC8291.senderPrivate) },
    );
    expect(sealed.toString('base64url')).toBe(RFC8291.body);
  });

  test('the fixed sender key really is the one the RFC names', () => {
    // Guards the vector itself: if `setPrivateKey` ever stopped deriving the
    // public half, the test above would still pass against a wrong constant.
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(b64(RFC8291.senderPrivate));
    expect(ecdh.getPublicKey().toString('base64url')).toBe(RFC8291.senderPublic);
  });

  test('a browser holding the subscription can read it back', () => {
    const sub = makeSubscription();
    const sealed = sealWebPushPayload(sub.keys, 'A session needs you');
    expect(openSealed(sealed, sub.privateKey, sub.publicKey, b64(sub.keys.auth))).toBe('A session needs you');
  });

  test('carries a JSON payload of the shape the worker reads', () => {
    const sub = makeSubscription();
    const payload = JSON.stringify({ title: 'relay-web', body: 'Waiting for your input', machineId: 'm-1' });
    const sealed = sealWebPushPayload(sub.keys, payload);
    expect(JSON.parse(openSealed(sealed, sub.privateKey, sub.publicKey, b64(sub.keys.auth)))).toEqual({
      title: 'relay-web',
      body: 'Waiting for your input',
      machineId: 'm-1',
    });
  });

  test('a fresh ephemeral key and salt every time, so no two records repeat', () => {
    const sub = makeSubscription();
    const a = sealWebPushPayload(sub.keys, 'same text');
    const b = sealWebPushPayload(sub.keys, 'same text');
    expect(a.equals(b)).toBe(false);
    // Salt and the ephemeral public key are both in the header.
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
  });

  test('a payload sealed for one subscription is unreadable by another', () => {
    const mine = makeSubscription();
    const theirs = makeSubscription();
    const sealed = sealWebPushPayload(mine.keys, 'private');
    expect(() => openSealed(sealed, theirs.privateKey, theirs.publicKey, b64(theirs.keys.auth))).toThrow();
  });

  test('the auth secret is load-bearing, not decoration', () => {
    const sub = makeSubscription();
    const sealed = sealWebPushPayload(sub.keys, 'private');
    // Same ECDH, different auth secret: without it in the key derivation this
    // would still decrypt, which is exactly the bug worth a test.
    expect(() => openSealed(sealed, sub.privateKey, sub.publicKey, Buffer.alloc(16, 6))).toThrow();
  });

  test('produces a body that fits what a push service will accept', () => {
    const sub = makeSubscription();
    const sealed = sealWebPushPayload(sub.keys, 'x'.repeat(MAX_PLAINTEXT_BYTES));
    expect(sealed.length).toBe(RECORD_SIZE);
  });

  test.each([
    ['a compressed point', { p256dh: Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 1)]).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') }],
    ['a short point', { p256dh: Buffer.alloc(32, 1).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') }],
    ['a short auth secret', { p256dh: makeSubscription().keys.p256dh, auth: Buffer.alloc(8).toString('base64url') }],
    ['an empty p256dh', { p256dh: '', auth: Buffer.alloc(16).toString('base64url') }],
  ])('refuses %s', (_label, keys) => {
    expect(() => sealWebPushPayload(keys, 'x')).toThrow(PushSealError);
  });

  test('refuses a point of the right length that is not on the curve', () => {
    const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 9)]).toString('base64url');
    expect(() => sealWebPushPayload({ p256dh: offCurve, auth: Buffer.alloc(16).toString('base64url') }, 'x')).toThrow(
      PushSealError,
    );
  });

  test('refuses a payload too large for one record', () => {
    const sub = makeSubscription();
    expect(() => sealWebPushPayload(sub.keys, 'x'.repeat(MAX_PLAINTEXT_BYTES + 1))).toThrow(PushSealError);
  });
});
