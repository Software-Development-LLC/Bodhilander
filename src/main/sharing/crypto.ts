import sodium from 'sodium-native';

// Shared secret size for symmetric encryption (32 bytes for XChaCha20-Poly1305)
const SHARED_SECRET_BYTES = 32;

export interface KeyPair {
  publicKey: Buffer;
  secretKey: Buffer;
}

export interface EncryptedMessage {
  ciphertext: Buffer;
  nonce: Buffer;
}

/**
 * Generate an X25519 key pair for key exchange
 */
export function generateKeyPair(): KeyPair {
  const publicKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
  const secretKey = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
  sodium.crypto_box_keypair(publicKey, secretKey);
  return { publicKey, secretKey };
}

/**
 * Derive a shared secret from our secret key and their public key
 * Uses X25519 scalar multiplication followed by BLAKE2b hash
 */
export function deriveSharedSecret(
  ourSecretKey: Buffer,
  theirPublicKey: Buffer,
): Buffer {
  // Perform X25519 Diffie-Hellman to get shared point
  const sharedPoint = Buffer.alloc(sodium.crypto_scalarmult_BYTES);
  sodium.crypto_scalarmult(sharedPoint, ourSecretKey, theirPublicKey);

  // Hash the shared point to derive the final symmetric key
  // This is the standard approach for converting a DH shared secret to a symmetric key
  const sharedSecret = Buffer.alloc(SHARED_SECRET_BYTES);
  sodium.crypto_generichash(sharedSecret, sharedPoint);

  return sharedSecret;
}

/**
 * Encrypt a message using XChaCha20-Poly1305
 */
export function encrypt(
  message: Buffer | string,
  sharedSecret: Buffer,
): EncryptedMessage {
  const messageBuffer = Buffer.isBuffer(message)
    ? message
    : Buffer.from(message, 'utf-8');

  const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
  sodium.randombytes_buf(nonce);

  const ciphertext = Buffer.alloc(
    messageBuffer.length + sodium.crypto_secretbox_MACBYTES,
  );

  sodium.crypto_secretbox_easy(ciphertext, messageBuffer, nonce, sharedSecret);

  return { ciphertext, nonce };
}

/**
 * Decrypt a message using XChaCha20-Poly1305
 */
export function decrypt(
  ciphertext: Buffer,
  nonce: Buffer,
  sharedSecret: Buffer,
): Buffer {
  const message = Buffer.alloc(
    ciphertext.length - sodium.crypto_secretbox_MACBYTES,
  );

  const success = sodium.crypto_secretbox_open_easy(
    message,
    ciphertext,
    nonce,
    sharedSecret,
  );

  if (!success) {
    throw new Error('Decryption failed - message may be corrupted or tampered');
  }

  return message;
}

/**
 * Convert buffer to base64 for transmission
 */
export function toBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

/**
 * Convert base64 to buffer
 */
export function fromBase64(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}
