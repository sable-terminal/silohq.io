// Key management in an HSM over PKCS#11 (decision 2026-11-14), through graphene-pk11: the
// sovereign cell's UK HSM (Thales Luna) and a customer's HSM on premises. The commercial
// cells keep Cloud KMS, whose HSM protection level is Cloud HSM. Keys never leave the HSM
// and are never created here: they are found by label, and a missing or unfit one fails.
//
// key_uri: pkcs11:object=<label> (RFC 7512's object attribute).
// - wrap: a secret AES key; AES-GCM in the HSM, the binding context as additional
//   authenticated data; stored as one byte giving the IV's length, the IV, the ciphertext and
//   the tag (D206).
// - mac: a secret key usable for SHA256-HMAC.
// - import: an RSA key pair (3072 or 4096 bits) under one label; RSA-OAEP with SHA-256 and
//   MGF1-SHA-256 decrypts in the HSM; the public half is exported as SPKI PEM.
// One session, logged in, serialised: PKCS#11 sessions are not shared across concurrent
// operations. A session lost to the HSM (a network HSM's failover, a dropped link) is opened
// again once before an operation fails.
//
// Profiles (PKCS11_PROFILE; D206):
// - generic: the slot by number or token label, the normal user, a fresh 12-byte IV from the
//   host for each wrap.
// - luna (the sovereign cell's Thales Luna): the partition by its token label, which an HA
//   group's virtual slot has too; logged in as the partition's Crypto User (Luna's
//   CKU_CRYPTO_USER, CKU_VENDOR_DEFINED + 1), which can use keys and never create or change
//   them; and the IV generated in the HSM. In FIPS mode Luna refuses an IV from the caller,
//   generates one and returns it after the ciphertext and tag: 16 bytes before firmware
//   7.9.3, the asked-for length (here 12) from 7.9.3. Both are read back.

import { createPublicKey, randomBytes } from 'node:crypto';
import type { KmsConfig } from '../config/kms.config.ts';
import type { KeyWrapper } from '../utils/envelope.util.ts';
import { AppError } from '../utils/errors.util.ts';
import { rsaCiphertext, sealedScheme } from '../utils/importKey.util.ts';
import type { KeyManagement, KeyUse, KeyVerdict } from './kms.infra.ts';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const TAG_BITS = TAG_BYTES * 8;
/** IV lengths a wrapped key may carry: the host's 12, Luna's 12 or 16. */
const IV_LENGTHS: ReadonlySet<number> = new Set([12, 16]);

/** CKU_USER; on a Luna partition, its Crypto Officer. */
const CKU_USER = 1;
/** A Luna partition's Crypto User (CKU_CRYPTO_USER, alias CKU_LIMITED_USER): CKU_VENDOR_DEFINED + 1. */
export const LUNA_CKU_CRYPTO_USER = 0x80000001;

/**
 * PKCS#11 results that mean the session, not the request, failed: CKR_DEVICE_ERROR,
 * CKR_DEVICE_REMOVED, CKR_SESSION_CLOSED, CKR_SESSION_HANDLE_INVALID, CKR_TOKEN_NOT_PRESENT,
 * CKR_USER_NOT_LOGGED_IN.
 */
const SESSION_LOST: ReadonlySet<number> = new Set([0x30, 0x32, 0xb0, 0xb3, 0xe0, 0x101]);
export const sessionLost = (cause: unknown): boolean => SESSION_LOST.has((cause as { code?: unknown } | null)?.code as number);

export function labelOf(keyUri: string): string {
  const match = /^pkcs11:object=([A-Za-z0-9._:-]{1,128})$/.exec(keyUri);
  if (!match) throw new AppError('configuration', 'a PKCS#11 key URI is pkcs11:object=<label>', { code: 'kms.pkcs11_hsm.uri' });
  return match[1]!;
}

const unavailable = (cause: unknown): AppError => new AppError('unavailable', 'the HSM is unavailable', { code: 'kms.pkcs11_hsm.unavailable', cause });
const refused = (cause?: unknown): AppError => new AppError('integrity', 'the key provider refused to unwrap', { code: 'kms.pkcs11_hsm.unwrap_refused', cause });

/** A wrapped key as stored: the IV's length in one byte, the IV, then the ciphertext and tag. */
export function encodeWrapped(iv: Buffer, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([iv.length]), iv, body]);
}

export function decodeWrapped(wrapped: Buffer): { iv: Buffer; body: Buffer } {
  const ivLength = wrapped[0];
  if (ivLength === undefined || !IV_LENGTHS.has(ivLength) || wrapped.length <= 1 + ivLength + TAG_BYTES) throw refused();
  return { iv: wrapped.subarray(1, 1 + ivLength), body: wrapped.subarray(1 + ivLength) };
}

/**
 * What Luna returns from an AES-GCM encryption in FIPS mode: the ciphertext, the tag, then
 * the IV it generated. An IV of an unexpected length, or the zeros it was given, is refused:
 * nothing is wrapped under an IV the HSM did not make.
 */
export function splitHsmIv(out: Buffer, plaintextBytes: number): { iv: Buffer; body: Buffer } {
  const ivLength = out.length - plaintextBytes - TAG_BYTES;
  if (!IV_LENGTHS.has(ivLength)) {
    throw new AppError('integrity', 'the HSM returned no IV of its own', { code: 'kms.pkcs11_hsm.iv_not_generated', details: { returned: out.length } });
  }
  const iv = out.subarray(out.length - ivLength);
  if (iv.every((b) => b === 0)) throw new AppError('integrity', 'the HSM returned no IV of its own', { code: 'kms.pkcs11_hsm.iv_not_generated' });
  return { iv, body: out.subarray(0, out.length - ivLength) };
}

/** The slot to use: by number, or the one whose token carries the label. */
export function chooseSlot<S extends { getToken(): { label: string } }>(slots: { length: number; items(index: number): S }, want: { slot?: number | undefined; tokenLabel?: string | undefined }): S {
  if (want.tokenLabel !== undefined) {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots.items(i);
      if (slot.getToken().label.trim() === want.tokenLabel.trim()) return slot;
    }
    throw new AppError('configuration', 'no token in the HSM carries that label', { code: 'kms.pkcs11_hsm.token_missing', details: { tokenLabel: want.tokenLabel } });
  }
  const index = want.slot ?? 0;
  if (index >= slots.length) throw new AppError('configuration', 'the HSM has no such slot', { code: 'kms.pkcs11_hsm.slot_missing', details: { slot: index } });
  return slots.items(index);
}

type Graphene = typeof import('graphene-pk11');

export async function pkcs11KeyManagement(config: KmsConfig, load: () => Promise<Graphene> = () => import('graphene-pk11')): Promise<KeyManagement> {
  if (config.pkcs11ModulePath === undefined || config.pkcs11Pin === undefined) {
    throw new AppError('configuration', 'the PKCS#11 HSM needs PKCS11_MODULE_PATH and PKCS11_PIN', { code: 'kms.pkcs11_hsm.config' });
  }
  const pin = config.pkcs11Pin;
  const luna = config.pkcs11Profile === 'luna';
  // Loaded on use: only a build that configures the HSM loads the native module.
  const graphene = await load();
  let mod: InstanceType<Graphene['Module']>;
  let session: InstanceType<Graphene['Session']>;
  const open = (): void => {
    const slot = chooseSlot(mod.getSlots(true), { slot: config.pkcs11Slot, tokenLabel: config.pkcs11TokenLabel });
    const next = slot.open(graphene.SessionFlag.SERIAL_SESSION | graphene.SessionFlag.RW_SESSION);
    try {
      next.login(pin, (luna ? LUNA_CKU_CRYPTO_USER : CKU_USER) as never);
    } catch (cause) {
      next.close();
      throw cause;
    }
    session = next;
  };
  try {
    mod = graphene.Module.load(config.pkcs11ModulePath, 'HSM');
    mod.initialize();
    open();
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw unavailable(cause);
  }

  // Serialised: one operation on the session at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => T): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  /** One operation; a lost session is opened again once, then the operation tried again. */
  const run = <T>(work: () => T, fail: (cause: unknown) => AppError): Promise<T> => serial(() => {
    try {
      return work();
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      if (!sessionLost(cause)) throw fail(cause);
    }
    try {
      try {
        session.close();
      } catch {
        // Already gone.
      }
      open();
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw unavailable(cause);
    }
    try {
      return work();
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw fail(cause);
    }
  });

  const find = (label: string, objectClass: number) => {
    const found = session.find({ class: objectClass, label });
    return found.length === 0 ? undefined : found.items(0);
  };
  const secret = (keyUri: string) => {
    const key = find(labelOf(keyUri), graphene.ObjectClass.SECRET_KEY);
    if (key === undefined) throw new AppError('configuration', 'no such key in the HSM', { code: 'kms.pkcs11_hsm.key_missing' });
    return key.toType<InstanceType<Graphene['SecretKey']>>();
  };

  /** AES-GCM in the HSM under the key: the IV the host's, or under the luna profile the HSM's own. */
  const wrapWith = (keyUri: string, dek: Buffer, context: Buffer): Buffer => {
    // Luna in FIPS mode makes the IV and refuses one given: it is passed zeros and read back.
    const iv = luna ? Buffer.alloc(IV_BYTES) : randomBytes(IV_BYTES);
    const cipher = session.createCipher({ name: 'AES_GCM', params: new graphene.AesGcmParams(iv, context, TAG_BITS) }, secret(keyUri));
    const out = Buffer.concat([cipher.update(dek), cipher.final()]);
    if (!luna) return encodeWrapped(iv, out);
    const generated = splitHsmIv(out, dek.length);
    return encodeWrapped(generated.iv, generated.body);
  };
  const unwrapWith = (keyUri: string, wrapped: Buffer, context: Buffer): Buffer => {
    const { iv, body } = decodeWrapped(wrapped);
    const decipher = session.createDecipher({ name: 'AES_GCM', params: new graphene.AesGcmParams(Buffer.from(iv), context, TAG_BITS) }, secret(keyUri));
    return Buffer.concat([decipher.update(body), decipher.final()]);
  };

  return {
    provider: 'pkcs11_hsm',
    wrapper(version): KeyWrapper {
      return {
        keyVersionId: version.id,
        wrap: (dek, context) => run(() => wrapWith(version.keyUri, Buffer.from(dek), Buffer.from(context)), unavailable),
        unwrap: (wrapped, context) => run(() => unwrapWith(version.keyUri, Buffer.from(wrapped), Buffer.from(context)), refused),
      };
    },

    mac: (keyUri, data) => run(() => Buffer.from(session.createSign('SHA256_HMAC', secret(keyUri)).once(data)), unavailable),

    importPublicKey: (keyUri) => run(() => {
      const key = find(labelOf(keyUri), graphene.ObjectClass.PUBLIC_KEY);
      if (key === undefined) throw new AppError('configuration', 'no such key in the HSM', { code: 'kms.pkcs11_hsm.key_missing' });
      const attrs = key.getAttribute({ modulus: null, publicExponent: null }) as { modulus: Buffer; publicExponent: Buffer };
      return createPublicKey({ key: { kty: 'RSA', n: attrs.modulus.toString('base64url'), e: attrs.publicExponent.toString('base64url') }, format: 'jwk' })
        .export({ type: 'spki', format: 'pem' }) as string;
    }, unavailable),

    importDecrypt: (keyUri, sealed) => {
      if (sealedScheme(sealed) !== 'rsa_oaep_sha256') return Promise.reject(refused());
      return run(() => {
        const key = find(labelOf(keyUri), graphene.ObjectClass.PRIVATE_KEY);
        if (key === undefined) throw new AppError('configuration', 'no such key in the HSM', { code: 'kms.pkcs11_hsm.key_missing' });
        const params = new graphene.RsaOaepParams(graphene.MechanismEnum.SHA256, graphene.RsaMgf.MGF1_SHA256);
        const ciphertext = rsaCiphertext(sealed);
        return Buffer.from(session.createDecipher({ name: 'RSA_PKCS_OAEP', params }, key.toType()).once(ciphertext, Buffer.alloc(ciphertext.length)));
      }, refused);
    },

    verifyKey: (keyUri: string, use: KeyUse): Promise<KeyVerdict> => run(() => {
      const label = labelOf(keyUri);
      if (use === 'import') {
        const priv = find(label, graphene.ObjectClass.PRIVATE_KEY);
        const pub = find(label, graphene.ObjectClass.PUBLIC_KEY);
        if (priv === undefined || pub === undefined) return 'missing';
        const bits = (pub.getAttribute({ modulus: null }) as { modulus: Buffer }).modulus.length * 8;
        const { decrypt } = priv.getAttribute({ decrypt: null }) as { decrypt: boolean };
        return decrypt && (bits === 3072 || bits === 4096) ? 'ok' : 'unusable';
      }
      const key = find(label, graphene.ObjectClass.SECRET_KEY);
      if (key === undefined) return 'missing';
      const attrs = key.getAttribute({ encrypt: null, decrypt: null, sign: null }) as { encrypt: boolean; decrypt: boolean; sign: boolean };
      if (use !== 'wrap') return attrs.sign ? 'ok' : 'unusable';
      if (!attrs.encrypt || !attrs.decrypt) return 'unusable';
      // A key that cannot wrap and unwrap here, as this profile does it, fails at start, not at first use.
      // An HSM that gave back no IV of its own is a profile that does not match the HSM: said so (iv_not_generated).
      const probe = randomBytes(32);
      const context = Buffer.from('silo:kms:verify');
      try {
        return unwrapWith(keyUri, wrapWith(keyUri, probe, context), context).equals(probe) ? 'ok' : 'unusable';
      } catch (cause) {
        if (cause instanceof AppError && cause.code !== 'kms.pkcs11_hsm.unwrap_refused') throw cause;
        if (sessionLost(cause)) throw cause;
        return 'unusable';
      }
    }, unavailable),

    async close() {
      await queue;
      try {
        session.logout();
        session.close();
        mod.finalize();
      } catch {
        // Closing is best effort: the process is ending.
      }
    },
  };
}
