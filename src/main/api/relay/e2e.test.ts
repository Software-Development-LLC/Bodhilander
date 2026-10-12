/**
 * Unit tests for the E2E channel crypto, with particular attention to the
 * per-channel key agreement that makes recorded channels unreplayable.
 *
 * Run with: bun test src/main/api/relay/e2e.test.ts
 */
import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import {
  deriveEphemeral,
  deriveSessionKey,
  nonceFromCounter,
  seal,
  open,
  sealJson,
  openJson,
  buildHandshakeProof,
} from './e2e';

/** Stand in for the browser: a fresh X25519 keypair and its raw public key. */
function clientKeypair() {
  const kp = crypto.generateKeyPairSync('x25519');
  const { x } = kp.publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey: kp.privateKey, pubRaw: new Uint8Array(Buffer.from(x, 'base64url')) };
}

/** The client half of the ECDH, against the agent's advertised ephemeral key. */
function clientDerive(privateKey: crypto.KeyObject, agentPubB64: string): Buffer {
  const publicKey = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(agentPubB64, 'base64').toString('base64url') },
    format: 'jwk',
  });
  return crypto.diffieHellman({ privateKey, publicKey });
}

describe('deriveEphemeral', () => {
  test('both sides derive the same shared secret', () => {
    const client = clientKeypair();
    const { sharedSecret, ephemeralPubB64 } = deriveEphemeral(client.pubRaw);

    expect(clientDerive(client.privateKey, ephemeralPubB64).equals(sharedSecret)).toBe(true);
  });

  test('advertises a 32-byte X25519 public key as standard base64', () => {
    const { ephemeralPubB64 } = deriveEphemeral(clientKeypair().pubRaw);

    expect(Buffer.from(ephemeralPubB64, 'base64')).toHaveLength(32);
    // Standard base64, not base64url — it goes on the wire and into the signed
    // handshake proof, where the browser compares the exact string.
    expect(ephemeralPubB64).not.toContain('-');
    expect(ephemeralPubB64).not.toContain('_');
  });

  test('the SAME peer key yields a different channel key every time', () => {
    // The replay defence. With a long-lived agent key this was a pure function
    // of the client's public key, so anyone who could open a channel could
    // re-present a recorded clientX25519Pub and get the same session key back.
    const client = clientKeypair();

    const first = deriveEphemeral(client.pubRaw);
    const second = deriveEphemeral(client.pubRaw);

    expect(second.ephemeralPubB64).not.toBe(first.ephemeralPubB64);
    expect(second.sharedSecret.equals(first.sharedSecret)).toBe(false);
  });

  test('frames recorded from one channel do not open on a replayed one', () => {
    // End-to-end statement of the same property: capture a sealed frame, then
    // re-open a channel with the identical client key and try to replay it.
    const client = clientKeypair();
    const recorded = deriveEphemeral(client.pubRaw);
    const captured = sealJson(deriveSessionKey(recorded.sharedSecret), 0, { type: 'terminal:input', data: 'rm -rf ~' });

    const replayed = deriveSessionKey(deriveEphemeral(client.pubRaw).sharedSecret);

    expect(() => openJson(replayed, captured)).toThrow();
  });

  test('rejects a peer key that is not 32 bytes', () => {
    expect(() => deriveEphemeral(new Uint8Array(31))).toThrow();
    expect(() => deriveEphemeral(new Uint8Array(0))).toThrow();
  });
});

describe('seal / open', () => {
  const key = deriveSessionKey(deriveEphemeral(clientKeypair().pubRaw).sharedSecret);

  test('round-trips a JSON value', () => {
    const frame = sealJson(key, 7, { type: 'terminal:output', data: 'hello' });

    expect(frame.n).toBe(7);
    expect(openJson(key, frame)).toEqual({ type: 'terminal:output', data: 'hello' });
  });

  test('rejects a tampered ciphertext', () => {
    const frame = seal(key, 0, new TextEncoder().encode('secret'));
    const raw = Buffer.from(frame.ct, 'base64');
    raw[0] ^= 0xff;

    expect(() => open(key, { n: 0, ct: raw.toString('base64') })).toThrow();
  });

  test('rejects a frame opened at the wrong counter', () => {
    const frame = sealJson(key, 3, { ok: true });

    expect(() => openJson(key, { ...frame, n: 4 })).toThrow();
  });

  test('nonces are a 96-bit big-endian counter', () => {
    expect(nonceFromCounter(0).toString('hex')).toBe('000000000000000000000000');
    expect(nonceFromCounter(1).toString('hex')).toBe('000000000000000000000001');
    expect(nonceFromCounter(258).toString('hex')).toBe('000000000000000000000102');
    // Distinct counters must never collide — that is what keeps AES-GCM safe.
    expect(nonceFromCounter(5).equals(nonceFromCounter(6))).toBe(false);
  });
});

describe('buildHandshakeProof', () => {
  test('binds both public keys, so a signature cannot be moved between exchanges', () => {
    const proof = Buffer.from(buildHandshakeProof('CLIENT_PUB', 'AGENT_PUB')).toString('utf8');

    expect(proof).toBe('e2e-handshake:v1\nCLIENT_PUB\nAGENT_PUB');
    // Swapping the keys must change the signed bytes.
    expect(Buffer.from(buildHandshakeProof('AGENT_PUB', 'CLIENT_PUB')).toString('utf8')).not.toBe(proof);
  });
});
