// What every cell-signed instruction to the Silo Agent shares (execution grants, spec 10.4;
// discovery scans, spec 10.5): Ed25519 over a fixed purpose prefix, a NUL and the
// instruction's JSON text, which travels as that text, so whoever checks it checks exactly the
// bytes signed, with no canonical form to agree on. A key is named by the base64url SHA-256 of
// its SubjectPublicKeyInfo. The prefix keeps one purpose's signature from passing as another's.
// The agent's side is agent/internal/signing.

import { createHash, sign, verify, type KeyObject } from 'node:crypto';

/** base64url SHA-256 of a public key's SubjectPublicKeyInfo (DER). */
export const instructionKeyId = (publicKey: KeyObject): string =>
  createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');

const message = (prefix: string, text: string): Buffer => Buffer.concat([Buffer.from(`${prefix}\u0000`, 'utf8'), Buffer.from(text, 'utf8')]);

/** The signature (base64url) of text under prefix. */
export const signInstruction = (prefix: string, text: string, privateKey: KeyObject): string =>
  sign(null, message(prefix, text), privateKey).toString('base64url');

/** Whether signature (base64url) is publicKey's over prefix and text. */
export const verifyInstruction = (prefix: string, text: string, signature: string, publicKey: KeyObject): boolean =>
  verify(null, message(prefix, text), publicKey, Buffer.from(signature, 'base64url'));
