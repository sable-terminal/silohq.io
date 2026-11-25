// Sealing to another cell's import key (spec 6.4: "encrypt to destination import key").
// A tenant migration is an encrypted export and import, never a live link: the
// destination cell publishes the public half of its import key, the source seals to it,
// and only the destination's KMS can open what was sealed. The private half never leaves
// the provider (kms.infra.ts importDecrypt).
//
// Two forms, chosen by the public key's type:
//   0x01 RSA-OAEP with SHA-256 (Cloud KMS RSA_DECRYPT_OAEP_*_SHA256, Vault transit rsa-*)
//        0x01 || RSA-OAEP-SHA256(plaintext)
//   0x02 X25519 (the local development provider)
//        0x02 || ephemeral public key (32) || nonce (12) || AES-256-GCM(key, plaintext) || tag
//        where key = HKDF-SHA256(shared secret, salt = ephemeral || recipient, info = INFO)
// Only short secrets are sealed this way (a bundle key, an organisation data key).

import {
  constants, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync,
  publicEncrypt, type KeyObject,
} from 'node:crypto';
import { aesGcmOpen, aesGcmSeal, NONCE_BYTES, TAG_BYTES } from './crypto.util.ts';
import { AppError } from './errors.util.ts';

const RSA_OAEP = 0x01;
const X25519 = 0x02;
const INFO = Buffer.from('silo.import_key.v1');
const RAW_X25519 = 32;
// DER prefixes of a raw X25519 key in PKCS#8 and SubjectPublicKeyInfo (RFC 8410).
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

const invalidKey = (): AppError =>
  new AppError('validation', 'the import key must be an RSA or X25519 public key in PEM', { code: 'import_key.invalid' });

function publicKeyOf(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw invalidKey();
  }
  if (key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 3072) return key;
  if (key.asymmetricKeyType === 'x25519') return key;
  throw invalidKey();
}

/** The key's identifier: SHA-256 of its SubjectPublicKeyInfo, hex. Recorded as tenant_migrations.destination_key_id. */
export function importKeyId(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyOf(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex');
}

/** Checks a public key can be sealed to, and returns it in its canonical PEM. */
export function canonicalImportKey(publicKeyPem: string): string {
  return publicKeyOf(publicKeyPem).export({ type: 'spki', format: 'pem' }).toString();
}

const derive = (shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), INFO, 32));

const rawX25519Public = (key: KeyObject): Buffer => key.export({ type: 'spki', format: 'der' }).subarray(X25519_SPKI.length);

export function sealToImportKey(publicKeyPem: string, plaintext: Uint8Array): Buffer {
  const recipient = publicKeyOf(publicKeyPem);
  if (recipient.asymmetricKeyType === 'rsa') {
    const sealed = publicEncrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, plaintext);
    return Buffer.concat([Buffer.from([RSA_OAEP]), sealed]);
  }
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralRaw = rawX25519Public(ephemeral.publicKey);
  const key = derive(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), ephemeralRaw, rawX25519Public(recipient));
  const { nonce, ciphertext } = aesGcmSeal(key, plaintext, ephemeralRaw);
  key.fill(0);
  return Buffer.concat([Buffer.from([X25519]), ephemeralRaw, nonce, ciphertext]);
}

/** The scheme a sealed value used, for the provider that opens it. */
export function sealedScheme(sealed: Buffer): 'rsa_oaep_sha256' | 'x25519' {
  if (sealed[0] === RSA_OAEP && sealed.length > 1) return 'rsa_oaep_sha256';
  if (sealed[0] === X25519 && sealed.length >= 1 + RAW_X25519 + NONCE_BYTES + TAG_BYTES) return 'x25519';
  throw new AppError('integrity', 'not a value sealed to an import key', { code: 'import_key.malformed' });
}

/** The RSA ciphertext inside an 0x01 value, for a provider that decrypts RSA-OAEP. */
export const rsaCiphertext = (sealed: Buffer): Buffer => sealed.subarray(1);

// ----------------------------------------------------------------------------- X25519 (local provider)

/** An X25519 key pair from 32 secret bytes (the local provider derives them from its key). */
export function x25519FromSeed(seed: Buffer): { privateKey: KeyObject; publicKeyPem: string } {
  if (seed.length !== RAW_X25519) throw new TypeError('an X25519 seed is 32 bytes');
  const privateKey = createPrivateKey({ key: Buffer.concat([X25519_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString() };
}

export function openX25519(privateKey: KeyObject, sealed: Buffer): Buffer {
  if (sealedScheme(sealed) !== 'x25519') throw new AppError('integrity', 'sealed for another kind of key', { code: 'import_key.scheme' });
  const ephemeralRaw = sealed.subarray(1, 1 + RAW_X25519);
  const nonce = sealed.subarray(1 + RAW_X25519, 1 + RAW_X25519 + NONCE_BYTES);
  const ciphertext = sealed.subarray(1 + RAW_X25519 + NONCE_BYTES);
  const ephemeral = createPublicKey({ key: Buffer.concat([X25519_SPKI, ephemeralRaw]), format: 'der', type: 'spki' });
  const recipientRaw = rawX25519Public(createPublicKey(privateKey));
  const key = derive(diffieHellman({ privateKey, publicKey: ephemeral }), ephemeralRaw, recipientRaw);
  try {
    return aesGcmOpen(key, { nonce, ciphertext }, ephemeralRaw);
  } finally {
    key.fill(0);
  }
}
