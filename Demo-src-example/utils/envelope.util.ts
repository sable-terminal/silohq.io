import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for credentials, IdP metadata, MFA secrets and SCIM tokens.
 *
 * A FRESH DATA KEY PER SECRET, WRAPPED BY A KEY THAT NEVER LEAVES KMS. The
 * alternative — encrypting everything directly with one KMS key — means every
 * decrypt is a network round trip, and rotating that key means re-encrypting the
 * whole table. Here the KEK wraps thousands of DEKs: rotation rewraps the keys,
 * not the data.
 *
 * AES-256-GCM, NOT CBC. GCM authenticates: a ciphertext altered in the database
 * fails to decrypt rather than decrypting to different plaintext. Without that,
 * an attacker with write access to the column can flip bits in a credential and
 * watch what the connector does with the result.
 *
 * A FRESH NONCE PER SEAL, AND THIS IS THE ONE THAT KILLS YOU. Reusing a nonce
 * with the same key in GCM does not merely weaken it — it leaks the XOR of the
 * two plaintexts and allows forgery of further ciphertexts. 96 bits from a CSPRNG
 * per seal, never a counter, never derived from the record id.
 *
 * THIS FILE DOES NOT TALK TO KMS. It takes a wrap and unwrap function, so the
 * scheme is testable without a network and the KMS client stays in infra.
 */

const ALGORITHM = 'aes-256-gcm';
const DEK_BYTES = 32;
const NONCE_BYTES = 12;

export interface Sealed {
  /** The ciphertext, nonce and auth tag. Opaque; store as bytes. */
  ciphertext: Buffer;
  /** The DEK, encrypted under the KEK. Stored beside the ciphertext. */
  wrappedKey: Buffer;
  /** Which KEK version wrapped it, so rotation knows what to rewrap. */
  keyReference: string;
}

export interface KeyWrapper {
  wrap(dek: Buffer): Promise<{ wrapped: Buffer; keyReference: string }>;
  unwrap(wrapped: Buffer, keyReference: string): Promise<Buffer>;
}

/**
 * Seal a secret.
 *
 * `additionalData` IS AUTHENTICATED BUT NOT ENCRYPTED, and it should be the id of
 * the row this belongs to. Without it a sealed credential can be copied from one
 * connection's row to another's and will decrypt happily — the ciphertext is
 * valid, it is simply in the wrong place. Binding it to the row makes that
 * substitution fail.
 */
export async function seal(
  plaintext: string,
  wrapper: KeyWrapper,
  additionalData?: string,
): Promise<Sealed> {
  const dek = randomBytes(DEK_BYTES);
  const nonce = randomBytes(NONCE_BYTES);

  const cipher = createCipheriv(ALGORITHM, dek, nonce);
  if (additionalData) cipher.setAAD(Buffer.from(additionalData, 'utf8'));

  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const { wrapped, keyReference } = await wrapper.wrap(dek);

  // The DEK is not zeroed: V8 gives no guarantee a Buffer is wiped, and
  // pretending otherwise is worse than not claiming it.
  return {
    // nonce ‖ tag ‖ body, so one column holds everything needed to open it and
    // there is no second field to forget to migrate.
    ciphertext: Buffer.concat([nonce, tag, body]),
    wrappedKey: wrapped,
    keyReference,
  };
}

/**
 * Open a sealed secret.
 *
 * THROWS ON TAMPERING, and callers must not catch-and-continue. A failed auth tag
 * means the ciphertext or the additional data is not what was sealed. Treating
 * that as "no credential" quietly turns an integrity failure into a connector
 * that reconnects with nothing.
 */
export async function unseal(
  sealed: Sealed,
  wrapper: KeyWrapper,
  additionalData?: string,
): Promise<string> {
  const dek = await wrapper.unwrap(sealed.wrappedKey, sealed.keyReference);

  const nonce = sealed.ciphertext.subarray(0, NONCE_BYTES);
  const tag = sealed.ciphertext.subarray(NONCE_BYTES, NONCE_BYTES + 16);
  const body = sealed.ciphertext.subarray(NONCE_BYTES + 16);

  const decipher = createDecipheriv(ALGORITHM, dek, nonce);
  decipher.setAuthTag(tag);
  if (additionalData) decipher.setAAD(Buffer.from(additionalData, 'utf8'));

  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** Whether a sealed value was wrapped by an older KEK and should be rewrapped. */
export function needsRewrap(sealed: Sealed, currentKeyReference: string): boolean {
  return sealed.keyReference !== currentKeyReference;
}
