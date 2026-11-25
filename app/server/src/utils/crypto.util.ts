// Cryptographic primitives every service shares. Node's crypto only; no third-party
// cryptography. Secrets are Buffers so they can be zeroed after use (spec 7.6:
// "Plaintext is zeroed after use"); strings cannot be.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.util.ts';

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

export function randomBytes(size: number): Buffer {
  return nodeRandomBytes(size);
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

export function hmacSha256(key: Uint8Array, data: string | Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

// A keyed hash of an identifier (an IP address, a user agent) for audit and session
// rows: comparable, never reversible by hashing a list of candidates. The purpose is
// mixed in, so one key never links the hash of an IP to the hash of a user agent.
export function keyedHash(key: Uint8Array, purpose: string, value: string): Buffer {
  return hmacSha256(key, `${purpose}\u0000${value}`);
}

// Equal-length comparison that takes the same time wherever the inputs differ. Unequal
// lengths return false at once; lengths here are public (hash and tag sizes).
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function zeroise(...buffers: (Uint8Array | undefined | null)[]): void {
  for (const buffer of buffers) buffer?.fill(0);
}

export interface AesGcmSealed {
  /** Ciphertext with the 16-byte GCM tag appended (spec 61.2: "Includes the GCM tag"). */
  ciphertext: Buffer;
  /** 96 bits, fresh per seal (spec 61.1). */
  nonce: Buffer;
}

// AES-256-GCM with a fresh 96-bit nonce. The associated data is authenticated, not
// encrypted: a sealed value moved to another row fails to open.
export function aesGcmSeal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): AesGcmSealed {
  if (key.length !== KEY_BYTES) throw new AppError('internal', 'AES-256-GCM needs a 256-bit key');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext, nonce };
}

// Opens a sealed value, or throws an integrity error. Tampered ciphertext, a wrong key,
// a wrong nonce and wrong associated data all fail the same way.
export function aesGcmOpen(key: Uint8Array, sealed: AesGcmSealed, aad: Uint8Array): Buffer {
  if (key.length !== KEY_BYTES) throw new AppError('internal', 'AES-256-GCM needs a 256-bit key');
  if (sealed.nonce.length !== NONCE_BYTES || sealed.ciphertext.length < TAG_BYTES) {
    throw new AppError('integrity', 'sealed value is malformed', { code: 'crypto.malformed' });
  }
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (cause) {
    throw new AppError('integrity', 'sealed value failed to open', { code: 'crypto.open_failed', cause });
  }
}

export function base64url(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

const BASE64 = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', 'ascii');

/** Standard base64 with padding, written into a buffer: a secret encoded without becoming a string. Zero it when done. */
export function base64Bytes(data: Uint8Array): Buffer {
  const out = Buffer.alloc(Math.ceil(data.length / 3) * 4);
  let at = 0;
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i]!;
    const b = i + 1 < data.length ? data[i + 1]! : 0;
    const c = i + 2 < data.length ? data[i + 2]! : 0;
    out[at++] = BASE64[a >> 2]!;
    out[at++] = BASE64[((a & 0x03) << 4) | (b >> 4)]!;
    out[at++] = i + 1 < data.length ? BASE64[((b & 0x0f) << 2) | (c >> 6)]! : 0x3d;
    out[at++] = i + 2 < data.length ? BASE64[c & 0x3f]! : 0x3d;
  }
  return out;
}
