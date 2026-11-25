// The credential mediator (spec 61.3): the only service that seals or opens a secret.
// tests/architecture/layers.test.ts keeps seal and withOpened to this folder.
//
// Every unwrap is recorded in iam.credential_unwraps with its reason, cached DEK or not,
// failed open or not (spec 61.4, 61.9). The plaintext lives only inside the withOpened
// callback and is zeroed when it settles; nothing here returns it.

import { noteUnwrap } from './unwrapRate.service.ts';
import type { KmsProvider } from '../../config/kms.config.ts';
import type { ServiceName } from '../../config/service.config.ts';
import { keyRing, type KeyManagement, type KeyRegistry, type KeyVersionRef } from '../../infra/kms.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { KmsKeyVersion } from '../../models/iam/kmsKeyVersion.model.ts';
import { credentialUnwrapRepo, kmsKeyVersionRepo } from '../../repos/iam/index.repo.ts';
import { zeroise } from '../../utils/crypto.util.ts';
import { DekCache, seal, sealBindings, withOpened, type KeyRing, type SealedSecret } from '../../utils/envelope.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { generateTotpSecret, totpUri, verifyTotp } from '../../utils/totp.util.ts';

// Which registry rows each configured adapter can open: the UK HSM is reached over PKCS#11.
const REGISTRY_PROVIDERS: Record<KmsProvider, KmsKeyVersion['provider'][]> = {
  gcp_kms: ['gcp_kms'],
  pkcs11_hsm: ['pkcs11_hsm', 'uk_hsm'],
  vault_transit: ['vault_transit'],
  local: ['local'],
};

/** iam.kms_key_versions through its repo, with the list cached for a minute. */
export function repoKeyRegistry(databases: Databases, provider: KmsProvider, cacheMs = 60_000): KeyRegistry {
  let cached: { at: number; rows: KmsKeyVersion[] } | undefined;
  const rows = async (): Promise<KmsKeyVersion[]> => {
    if (cached && Date.now() - cached.at < cacheMs) return cached.rows;
    const fresh = await inTransaction(databases.pool('control'), {}, (db) => kmsKeyVersionRepo.listUsable(db, REGISTRY_PROVIDERS[provider]));
    cached = { at: Date.now(), rows: fresh };
    return fresh;
  };
  const ref = (row: KmsKeyVersion): KeyVersionRef => ({ id: row.id, keyUri: row.keyUri });
  return {
    async active() {
      const row = (await rows()).find((r) => r.status === 'active');
      if (!row) throw new AppError('configuration', 'no key version is active (spec 61.1)', { code: 'kms.no_active_key' });
      return ref(row);
    },
    async byId(id) {
      const row = (await rows()).find((r) => r.id === id)
        ?? await inTransaction(databases.pool('control'), {}, (db) => kmsKeyVersionRepo.findById(db, id));
      return row ? { ...ref(row), status: row.status } : undefined;
    },
    async usable() {
      return (await rows()).map(ref);
    },
  };
}

export interface CredentialServiceDeps {
  kms: KeyManagement;
  registry: KeyRegistry;
  databases: Databases;
  logger: Logger;
  cache?: DekCache;
}

export interface TotpEnrolment {
  sealed: SealedSecret;
  /** Shown once, to the authenticator. Never stored or logged. */
  otpauthUri: string;
}

export interface TotpVerification {
  factorId: string;
  userId: string;
  /** The organisation being logged into: the unwrap is recorded in its ledger. */
  organisationId: string;
  sealed: SealedSecret;
  code: string;
  lastUsedStep: number | null;
  callingService: ServiceName;
  correlationId: string;
}

export interface CredentialService {
  readonly keys: KeyRing;
  enrolTotp(input: { factorId: string; userId: string; accountName: string; issuer: string }): Promise<TotpEnrolment>;
  /** The time step the code matched, or null. A code at or before lastUsedStep never matches. */
  verifyTotp(input: TotpVerification): Promise<number | null>;
}

export function createCredentialService(deps: CredentialServiceDeps): CredentialService {
  const keys = keyRing(deps.kms, deps.registry);
  const cache = deps.cache ?? new DekCache();
  const control = deps.databases.pool('control');

  return {
    keys,
    async enrolTotp(input) {
      const secret = generateTotpSecret();
      try {
        const sealed = await seal(keys, secret, sealBindings.mfaFactor({ id: input.factorId, userId: input.userId, kind: 'totp' }));
        return { sealed, otpauthUri: totpUri(secret, input.issuer, input.accountName) };
      } finally {
        zeroise(secret);
      }
    },

    async verifyTotp(input) {
      const binding = sealBindings.mfaFactor({ id: input.factorId, userId: input.userId, kind: 'totp' });
      let outcome: 'ok' | 'failed' = 'failed';
      let dekCacheHit = false;
      try {
        const opened = await withOpened(keys, input.sealed, binding, async (secret) =>
          verifyTotp(secret, input.code, input.lastUsedStep === null ? {} : { lastAcceptedStep: input.lastUsedStep }), cache);
        outcome = 'ok';
        dekCacheHit = opened.dekCacheHit;
        return opened.value ?? null;
      } finally {
        // Recorded whether the code matched or not, and whether the open failed (spec 61.9); counted for the unwrap page (D252).
        noteUnwrap();
        await inTransaction(control, { organisationId: input.organisationId, userId: input.userId }, (db) =>
          credentialUnwrapRepo.insert(db, {
            organisationId: input.organisationId, mfaFactorId: input.factorId, userId: input.userId, reason: 'mfa_verify',
            callingService: input.callingService, correlationId: input.correlationId, keyVersionId: input.sealed.keyVersionId,
            dekCacheHit, outcome,
          }));
      }
    },
  };
}
