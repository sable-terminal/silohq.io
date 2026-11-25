// Hybrid Public Key Encryption (RFC 9180), base mode, single shot, in one suite:
// DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM. What the credential service seals a
// cell-custody login with, for the one Silo Agent that runs the call (spec 10.7); the agent
// opens it with Go's crypto/hpke.
//
// The KEM is Node's (crypto.encapsulate and decapsulate, OpenSSL's RFC 9180 DHKEM for X25519
// keys). The key schedule is RFC 9180 section 5.1 for mode_base with no PSK: LabeledExtract and
// LabeledExpand over HKDF-SHA256, then the AEAD with the base nonce, as the first and only
// message (sequence 0). The wire form is Go's single-shot form: the encapsulated key, then the
// ciphertext and tag. tests/utils/hpke.test.ts checks it against Go's implementation both ways.

import { createCipheriv, createDecipheriv, createHmac, createPublicKey, decapsulate, encapsulate, type KeyObject } from 'node:crypto';

const KEM_ID = 0x0020; // DHKEM(X25519, HKDF-SHA256)
const KDF_ID = 0x0001; // HKDF-SHA256
const AEAD_ID = 0x0002; // AES-256-GCM
const N_ENC = 32;
const N_K = 32;
const N_N = 12;
const N_T = 16;

const i2osp = (value: number, length: number): Buffer => {
  const out = Buffer.alloc(length);
  out.writeUIntBE(value, 0, length);
  return out;
};
const SUITE_ID = Buffer.concat([Buffer.from('HPKE', 'ascii'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2)]);
const VERSION = Buffer.from('HPKE-v1', 'ascii');

const extract = (salt: Buffer, ikm: Buffer): Buffer => createHmac('sha256', salt).update(ikm).digest();
function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i++) {
    previous = createHmac('sha256', prk).update(Buffer.concat([previous, info, Buffer.from([i])])).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}
const labeledExtract = (salt: Buffer, label: string, ikm: Buffer): Buffer =>
  extract(salt, Buffer.concat([VERSION, SUITE_ID, Buffer.from(label, 'ascii'), ikm]));
const labeledExpand = (prk: Buffer, label: string, info: Buffer, length: number): Buffer =>
  expand(prk, Buffer.concat([i2osp(length, 2), VERSION, SUITE_ID, Buffer.from(label, 'ascii'), info]), length);

/** RFC 9180 KeySchedule for mode_base: the AEAD key and base nonce. */
function keySchedule(sharedSecret: Buffer, info: Buffer): { key: Buffer; nonce: Buffer } {
  const empty = Buffer.alloc(0);
  const pskIdHash = labeledExtract(empty, 'psk_id_hash', empty);
  const infoHash = labeledExtract(empty, 'info_hash', info);
  const context = Buffer.concat([Buffer.from([0x00]), pskIdHash, infoHash]);
  const secret = labeledExtract(sharedSecret, 'secret', empty);
  return { key: labeledExpand(secret, 'key', context, N_K), nonce: labeledExpand(secret, 'base_nonce', context, N_N) };
}

function x25519(key: KeyObject, kind: 'public' | 'private'): KeyObject {
  if (key.asymmetricKeyType !== 'x25519' || key.type !== kind) throw new TypeError(`an X25519 ${kind} key is needed`);
  return key;
}

/** An X25519 public key from its 32 raw bytes (RFC 7748), as an agent sends it. */
export function x25519PublicKey(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new TypeError('an X25519 public key is 32 bytes');
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/** Seals plaintext to the recipient's public key, bound to info: enc || ciphertext || tag. */
export function hpkeSeal(recipient: KeyObject, info: Buffer, plaintext: Buffer): Buffer {
  const { sharedKey, ciphertext: enc } = encapsulate(x25519(recipient, 'public'));
  const { key, nonce } = keySchedule(sharedKey, info);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return Buffer.concat([enc, sealed]);
  } finally {
    sharedKey.fill(0);
    key.fill(0);
  }
}

/** Opens what hpkeSeal sealed to this private key under the same info; throws if anything differs. */
export function hpkeOpen(recipient: KeyObject, info: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < N_ENC + N_T) throw new Error('hpke: too short');
  const sharedKey = decapsulate(x25519(recipient, 'private'), sealed.subarray(0, N_ENC));
  const { key, nonce } = keySchedule(sharedKey, info);
  try {
    const body = sealed.subarray(N_ENC, sealed.length - N_T);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - N_T));
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } finally {
    sharedKey.fill(0);
    key.fill(0);
  }
}
