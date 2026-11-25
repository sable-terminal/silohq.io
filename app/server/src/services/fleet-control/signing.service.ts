// Release signatures (spec 11.1, 11.4): Ed25519 over the canonical JSON of a document,
// prefixed with what kind of document it is, so a signature on a channel head can never
// pass as one on a release or a bundle.
//
// The signing key sits behind Signer. This build signs with a key file (development and
// tests; production refuses it, config/index.config.ts); the HSM signer of spec 11.1
// implements the same interface. Verification needs only public keys, and is what a
// cell's Fleet agent and the on-premises bundle loader run.

import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import type { SignatureRecord, SigningRole } from '../../contracts/fleet-control/release.contract.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { AppError } from '../../utils/errors.util.ts';

export const SIGNED_DOCUMENTS = {
  release: 'silo.release.v1',
  channel: 'silo.channel.v1',
  bundle: 'silo.bundle.v1',
  /** The reviewed concept template set (22.7; D210), installed by each cell's catalogue. */
  templates: 'silo.concept_templates.v1',
} as const;

export type SignedDocument = keyof typeof SIGNED_DOCUMENTS;

export interface Signer {
  readonly role: SigningRole;
  readonly keyId: string;
  readonly publicKey: KeyObject;
  sign(message: Buffer): Promise<Buffer>;
}

export interface TrustedKey {
  role: SigningRole;
  keyId: string;
  key: KeyObject;
}

/** base64url SHA-256 of the public key's SubjectPublicKeyInfo (DER). */
export function keyIdOf(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
}

export function trustedKey(publicKey: KeyObject, role: SigningRole): TrustedKey {
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new AppError('configuration', 'a release key is Ed25519', { code: 'fleet.key_type' });
  return { role, keyId: keyIdOf(publicKey), key: publicKey };
}

/** A signer holding the private key in this process: development and tests only. */
export function keyFileSigner(privateKey: KeyObject, role: SigningRole, publicKey: KeyObject): Signer {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new AppError('configuration', 'a release key is Ed25519', { code: 'fleet.key_type' });
  return {
    role,
    keyId: keyIdOf(publicKey),
    publicKey,
    async sign(message) {
      return sign(null, message, privateKey);
    },
  };
}

const messageOf = (kind: SignedDocument, document: unknown): Buffer =>
  Buffer.concat([Buffer.from(`${SIGNED_DOCUMENTS[kind]}\u0000`, 'utf8'), canonicalJsonBytes(document)]);

/** sha256:<hex> of the document's canonical JSON. */
export function documentDigest(document: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonBytes(document)).digest('hex')}`;
}

export async function signDocument(signer: Signer, kind: SignedDocument, document: unknown): Promise<SignatureRecord> {
  const signature = await signer.sign(messageOf(kind, document));
  return { keyId: signer.keyId, role: signer.role, signature: signature.toString('base64url') };
}

/**
 * Passes only if, for every role required, a signature by a trusted key of that role
 * verifies. A signature by a key not trusted is ignored; a signature by a trusted key
 * that does not verify fails the whole document, because it means tampering.
 */
export function verifyDocument(
  kind: SignedDocument,
  document: unknown,
  signatures: readonly SignatureRecord[],
  trusted: readonly TrustedKey[],
  required: readonly SigningRole[],
): void {
  const message = messageOf(kind, document);
  const verifiedRoles = new Set<SigningRole>();
  for (const record of signatures) {
    const key = trusted.find((k) => k.keyId === record.keyId && k.role === record.role);
    if (key === undefined) continue;
    if (!verify(null, message, key.key, Buffer.from(record.signature, 'base64url'))) {
      throw new AppError('integrity', `a ${record.role} signature on this ${kind} does not verify`, {
        code: 'fleet.signature_invalid', details: { role: record.role, document: kind },
      });
    }
    verifiedRoles.add(record.role);
  }
  for (const role of required) {
    if (!verifiedRoles.has(role)) {
      throw new AppError('integrity', `this ${kind} has no valid ${role} signature`, {
        code: 'fleet.signature_missing', details: { role, document: kind },
      });
    }
  }
}
