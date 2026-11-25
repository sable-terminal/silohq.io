// The envelope scheme of spec 61 for every sealed secret: connection credentials, MFA
// secrets and identity provider metadata.
//
//   seal: fresh 256-bit DEK -> AES-256-GCM(DEK, fresh 96-bit nonce, row AAD) -> ciphertext
//         -> KEK.wrap(DEK, wrap context) -> dek_wrapped
//
// The row AAD binds the ciphertext to its row (id, organisation or user, and the row's
// own identifying columns): moved to another row or tenant, it fails to open. The KEK
// version is bound through the wrap context, never the row AAD (design review D2), so
// rotation re-wraps the DEK without decrypting the secret (spec 61.5).
//
// The KEK never enters the process: wrapping happens in the KMS or HSM behind a
// KeyWrapper (src/infra/kms.infra.ts). Only the credential service seals and opens
// (spec 61.3: the single mediator); this module is its machinery, not a second path.

import { canonicalJsonBytes } from './canonicalJson.util.ts';
import { aesGcmOpen, aesGcmSeal, KEY_BYTES, randomBytes, sha256, zeroise } from './crypto.util.ts';
import { AppError } from './errors.util.ts';

/** A key-encryption key version held by a KMS or HSM. Wraps and unwraps DEKs only. */
export interface KeyWrapper {
  /** The kms_key_versions row this wrapper stands for. */
  readonly keyVersionId: string;
  wrap(dek: Buffer, context: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer, context: Buffer): Promise<Buffer>;
}

/** The cell's key versions: the active one wraps; any non-retired one unwraps. */
export interface KeyRing {
  active(): Promise<KeyWrapper>;
  version(keyVersionId: string): Promise<KeyWrapper>;
}

/** The columns that identify a sealed row; they become the AAD. Strings only. */
export type SealBinding = Readonly<{ table: string } & Record<string, string>>;

export interface SealedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  dekWrapped: Buffer;
  keyVersionId: string;
}

// The AAD contract of each sealed table (design review D2). One place, so a writer and a
// reader can never disagree about which columns are bound.
export const sealBindings = {
  connectionCredential(row: {
    id: string; organisationId: string; connectionId: string | null; fieldName: string; purpose: string;
  }): SealBinding {
    return {
      table: 'connect.connection_credentials', id: row.id, organisation_id: row.organisationId,
      connection_id: row.connectionId ?? '', field_name: row.fieldName, purpose: row.purpose,
    };
  },
  mfaFactor(row: { id: string; userId: string; kind: string }): SealBinding {
    return { table: 'iam.mfa_factors', id: row.id, user_id: row.userId, kind: row.kind };
  },
  identityProvider(row: { id: string; organisationId: string; kind: string }): SealBinding {
    return { table: 'iam.identity_providers', id: row.id, organisation_id: row.organisationId, kind: row.kind };
  },
} as const;

const rowAad = (binding: SealBinding): Buffer => canonicalJsonBytes({ v: 1, aad: 'secret', ...binding });
const wrapContext = (binding: SealBinding, keyVersionId: string): Buffer =>
  canonicalJsonBytes({ v: 1, aad: 'dek', key_version_id: keyVersionId, ...binding });
/** The KMS context a sealed row's DEK is wrapped with under a key version: for re-wrapping on rotation (spec 61.2). */
export const wrapContextOf = wrapContext;

export async function seal(keys: KeyRing, plaintext: Uint8Array, binding: SealBinding): Promise<SealedSecret> {
  const dek = randomBytes(KEY_BYTES);
  try {
    const { ciphertext, nonce } = aesGcmSeal(dek, plaintext, rowAad(binding));
    const wrapper = await keys.active();
    const dekWrapped = await wrapper.wrap(dek, wrapContext(binding, wrapper.keyVersionId));
    return { ciphertext, nonce, dekWrapped, keyVersionId: wrapper.keyVersionId };
  } finally {
    zeroise(dek);
  }
}

// Unwrapped DEKs, kept for at most 5 minutes or 200 uses (spec 61.4). Never plaintext
// secrets. An evicted DEK is zeroed.
export class DekCache {
  private readonly entries = new Map<string, { dek: Buffer; expiresAt: number; usesLeft: number }>();
  private readonly maxAgeMs: number;
  private readonly maxUses: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { maxAgeMs?: number; maxUses?: number; maxEntries?: number; now?: () => number } = {}) {
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
    this.maxUses = options.maxUses ?? 200;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  private static key(keyVersionId: string, dekWrapped: Buffer): string {
    return sha256(Buffer.concat([Buffer.from(keyVersionId), Buffer.from([0]), dekWrapped])).toString('hex');
  }

  /** A copy of the cached DEK, counting one use, or undefined. The caller zeroes the copy. */
  take(keyVersionId: string, dekWrapped: Buffer): Buffer | undefined {
    const key = DekCache.key(keyVersionId, dekWrapped);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now() || entry.usesLeft <= 0) {
      this.evict(key);
      return undefined;
    }
    entry.usesLeft -= 1;
    const copy = Buffer.from(entry.dek);
    if (entry.usesLeft <= 0) this.evict(key);
    return copy;
  }

  put(keyVersionId: string, dekWrapped: Buffer, dek: Buffer): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.evict(oldest);
    }
    this.entries.set(DekCache.key(keyVersionId, dekWrapped), {
      dek: Buffer.from(dek), expiresAt: this.now() + this.maxAgeMs, usesLeft: this.maxUses,
    });
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.evict(key);
  }

  private evict(key: string): void {
    zeroise(this.entries.get(key)?.dek);
    this.entries.delete(key);
  }
}

async function unwrapDek(keys: KeyRing, sealed: SealedSecret, binding: SealBinding, cache?: DekCache)
  : Promise<{ dek: Buffer; dekCacheHit: boolean }> {
  const cached = cache?.take(sealed.keyVersionId, sealed.dekWrapped);
  if (cached) return { dek: cached, dekCacheHit: true };
  const wrapper = await keys.version(sealed.keyVersionId);
  const dek = await wrapper.unwrap(sealed.dekWrapped, wrapContext(binding, sealed.keyVersionId));
  if (dek.length !== KEY_BYTES) {
    zeroise(dek);
    throw new AppError('integrity', 'unwrapped data key has the wrong length', { code: 'crypto.dek_length' });
  }
  cache?.put(sealed.keyVersionId, sealed.dekWrapped, dek);
  return { dek, dekCacheHit: false };
}

// Opens a sealed secret, hands the plaintext to use, and zeroes it when use settles
// (spec 61.3: the plaintext is in scope only inside the callback). dekCacheHit is for
// the credential_unwraps ledger, which records every use, cached or not.
export async function withOpened<T>(
  keys: KeyRing,
  sealed: SealedSecret,
  binding: SealBinding,
  use: (plaintext: Buffer) => Promise<T>,
  cache?: DekCache,
): Promise<{ value: T; dekCacheHit: boolean }> {
  const { dek, dekCacheHit } = await unwrapDek(keys, sealed, binding, cache);
  let plaintext: Buffer | undefined;
  try {
    plaintext = aesGcmOpen(dek, { ciphertext: sealed.ciphertext, nonce: sealed.nonce }, rowAad(binding));
    return { value: await use(plaintext), dekCacheHit };
  } finally {
    zeroise(dek, plaintext);
  }
}

// Rotation (spec 61.5): re-wraps the DEK under the active key version. The ciphertext and
// nonce are untouched and never decrypted, so the row is wholly old or wholly new.
export async function rewrap(keys: KeyRing, sealed: SealedSecret, binding: SealBinding)
  : Promise<{ dekWrapped: Buffer; keyVersionId: string }> {
  const { dek } = await unwrapDek(keys, sealed, binding);
  try {
    const wrapper = await keys.active();
    const dekWrapped = await wrapper.wrap(dek, wrapContext(binding, wrapper.keyVersionId));
    return { dekWrapped, keyVersionId: wrapper.keyVersionId };
  } finally {
    zeroise(dek);
  }
}

// The only clear-text fragment of a secret (spec 61.1 step 8): computed from the plaintext
// before sealing, by the sealer, never supplied by a caller.
export function lastFour(plaintext: string): string {
  return [...plaintext].slice(-4).join('');
}
