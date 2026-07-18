/**
 * Browser (WebCrypto) half of the E2E session. Byte-compatible with the agent's
 * Node-crypto e2e.ts — verified end-to-end. AES-256-GCM under an X25519+HKDF key;
 * the agent's ephemeral key is authenticated with its Ed25519 identity so a
 * MITMing relay is detectable (verify against the machine's known fingerprint).
 */

const HKDF_SALT = 'bodhilander-relay-salt:v1';
const HKDF_INFO = 'bodhilander-relay-e2e:v1';
const HANDSHAKE_VERSION = 'e2e-handshake:v1';
const subtle = crypto.subtle;

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: ArrayBuffer | Uint8Array) => new TextDecoder().decode(u);

function toB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function nonce(counter: number): Uint8Array {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, BigInt(counter)); // big-endian, high 4 bytes zero
  return n;
}
/** Copy to a plain ArrayBuffer (WebCrypto BufferSource; sidesteps lib typing). */
function ab(u: Uint8Array): ArrayBuffer {
  const b = new ArrayBuffer(u.byteLength);
  new Uint8Array(b).set(u);
  return b;
}
// X25519 / Ed25519 aren't in the DOM lib's algorithm unions yet; cast at the call.
type Algo = { name: string; [k: string]: unknown };
const algo = (a: Algo) => a as unknown as AlgorithmIdentifier;

export interface SealedFrame {
  n: number;
  ct: string;
}
export interface ClientKeys {
  pubB64: string;
  priv: CryptoKey;
}

/** Generate the client's ephemeral X25519 keypair for this session. */
export async function generateClientKeys(): Promise<ClientKeys> {
  const kp = (await subtle.generateKey(algo({ name: 'X25519' }), true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { pubB64: toB64(pub), priv: kp.privateKey };
}

/** Derive the AES-256-GCM session key from the agent's X25519 public key. */
export async function deriveSessionKey(priv: CryptoKey, agentX25519PubB64: string): Promise<CryptoKey> {
  const agentPub = await subtle.importKey('raw', ab(fromB64(agentX25519PubB64)), algo({ name: 'X25519' }), false, []);
  const shared = new Uint8Array(await subtle.deriveBits(algo({ name: 'X25519', public: agentPub }), priv, 256));
  const hk = await subtle.importKey('raw', ab(shared), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(algo({ name: 'HKDF', hash: 'SHA-256', salt: ab(enc(HKDF_SALT)), info: ab(enc(HKDF_INFO)) }), hk, 256);
  return subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealJson(key: CryptoKey, counter: number, value: unknown): Promise<SealedFrame> {
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: ab(nonce(counter)) }, key, ab(enc(JSON.stringify(value)))));
  return { n: counter, ct: toB64(ct) };
}
export async function openJson<T>(key: CryptoKey, frame: SealedFrame): Promise<T> {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: ab(nonce(frame.n)) }, key, ab(fromB64(frame.ct)));
  return JSON.parse(dec(pt)) as T;
}

/** Verify the agent's Ed25519-signed proof that its X25519 key belongs to it. */
export async function verifyHandshakeProof(
  agentEd25519PubB64: string,
  agentX25519PubB64: string,
  clientX25519PubB64: string,
  signatureB64: string,
): Promise<boolean> {
  try {
    const key = await subtle.importKey('raw', ab(fromB64(agentEd25519PubB64)), algo({ name: 'Ed25519' }), false, ['verify']);
    const msg = enc(`${HANDSHAKE_VERSION}\n${clientX25519PubB64}\n${agentX25519PubB64}`);
    return await subtle.verify(algo({ name: 'Ed25519' }), key, ab(fromB64(signatureB64)), ab(msg));
  } catch {
    return false;
  }
}

/** SSH-style fingerprint of an Ed25519 pubkey — matches the desktop's identityFingerprint. */
export async function fingerprint(ed25519PubB64: string): Promise<string> {
  const hash = new Uint8Array(await subtle.digest('SHA-256', ab(fromB64(ed25519PubB64))));
  return 'SHA256:' + toB64(hash).replace(/=+$/, '');
}
