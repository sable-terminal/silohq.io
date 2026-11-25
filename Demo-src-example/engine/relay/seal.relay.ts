import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';

/**
 * Sealing a frame to one recipient: X25519, HKDF-SHA256, AES-256-GCM.
 *
 * ── WHY NOT THE ENVELOPE THE CREDENTIALS USE ──────────────────────────────
 *
 * `envelope.util` seals to a key Silo holds (KMS). A job frame must be sealed to
 * a key only the AGENT holds, so that Redis, another Silo instance and anything
 * reading the relay in between see ciphertext; and a result to a key only the
 * instance that asked holds. Public-key sealing is the only shape that does
 * that, and this is the smallest standard construction of it.
 *
 * FORMAT, version 1: `0x01 | ephemeral public key (32) | nonce (12) | tag (16) |
 * ciphertext`. The key is HKDF over the shared secret, salted with both public
 * keys, so a frame sealed to one recipient cannot be replayed as sealed to
 * another. `binding` is authenticated but not encrypted — the job id — so a
 * frame cannot be answered as a different job.
 */

const VERSION = 1;
const INFO = Buffer.from('silo-agent-frame v1');
/** DER prefix of an X25519 SubjectPublicKeyInfo; the raw key follows it. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface KeyPair {
  /** The raw 32-byte public key, base64: what is stored and sent. */
  publicKey: string;
  privateKey: KeyObject;
}

export function keyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: rawOf(publicKey), privateKey };
}

const rawOf = (key: KeyObject): string => (key.export({ format: 'der', type: 'spki' }) as Buffer).subarray(SPKI_PREFIX.length).toString('base64');

function publicKeyOf(raw: string): KeyObject {
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32) throw new Error('An agent public key is 32 bytes.');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, bytes]), format: 'der', type: 'spki' });
}

/** A private key as PKCS#8 PEM, for the agent's own file, and back. */
export const exportPrivateKey = (key: KeyObject): string => key.export({ format: 'pem', type: 'pkcs8' }) as string;
export const importPrivateKey = (pem: string): KeyObject => createPrivateKey(pem);
export const publicKeyFor = (key: KeyObject): string => rawOf(createPublicKey(key));

function derive(shared: Buffer, ephemeral: string, recipient: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([Buffer.from(ephemeral, 'base64'), Buffer.from(recipient, 'base64')]), INFO, 32));
}

export function seal(recipientPublicKey: string, plaintext: Buffer, binding: string): Buffer {
  const ephemeral = keyPair();
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyOf(recipientPublicKey) });
  const key = derive(shared, ephemeral.publicKey, recipientPublicKey);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(binding, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), Buffer.from(ephemeral.publicKey, 'base64'), nonce, cipher.getAuthTag(), body]);
}

export function open(privateKey: KeyObject, sealed: Buffer, binding: string): Buffer {
  if (sealed.length < 61 || sealed[0] !== VERSION) throw new Error('Not a sealed frame this version can open.');
  const ephemeral = sealed.subarray(1, 33).toString('base64');
  const nonce = sealed.subarray(33, 45);
  const tag = sealed.subarray(45, 61);
  const shared = diffieHellman({ privateKey, publicKey: publicKeyOf(ephemeral) });
  const key = derive(shared, ephemeral, publicKeyFor(privateKey));
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(binding, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(61)), decipher.final()]);
}
