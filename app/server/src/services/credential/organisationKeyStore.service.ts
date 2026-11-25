// Organisation keys (design: iam.organisation_keys): a 256-bit key per organisation and
// purpose, wrapped by the cell KEK. `data` seals record values at rest; `hmac` keys the
// entity graph's hashes (spec 23.3). Only the credential service unwraps them (spec 61.3).
//
// - Created on first use, at the next version, wrapped by the active KEK version. The wrap
//   context, which is the KMS encryption context, binds the key to its row (table, id,
//   organisation, purpose, version) and to the KEK version (review D2), so a wrapped key
//   moved to another row, tenant or purpose does not unwrap. Two processes creating it at
//   once: the active-key unique index lets one win, and the other reads the winner.
// - Unwrapped keys stay in memory for at most five minutes, then are zeroed. Callers use a
//   key synchronously after it is returned and never keep it: the store owns the buffer.
// - These are not connection credentials: iam.credential_unwraps names one credential per
//   unwrap, so these unwraps are logged, not written to that ledger.

import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { OrganisationKey } from '../../models/iam/index.model.ts';
import { organisationKeyRepo } from '../../repos/iam/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { KEY_BYTES, randomBytes, zeroise } from '../../utils/crypto.util.ts';
import type { KeyRing } from '../../utils/envelope.util.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

const CACHE_MS = 5 * 60_000;

export type OrganisationKeyPurpose = OrganisationKey['purpose'];

export interface OrganisationKeyStore {
  /** The active key of this purpose, created on first use. */
  active(organisationId: string, purpose: OrganisationKeyPurpose): Promise<{ id: string; version: number; key: Buffer }>;
  /** A key by version, to open what an earlier key sealed. Refused once retired. */
  atVersion(organisationId: string, purpose: OrganisationKeyPurpose, version: number): Promise<Buffer>;
  /** Zeroes every cached key. */
  close(): void;
}

interface Row { id: string; organisationId: string; purpose: OrganisationKeyPurpose; version: number }

/** The KMS encryption context of an organisation key: its row and the KEK version. Also used by tenantKeys.service.ts. */
export const organisationKeyWrapContext = (row: Row, kekVersionId: string): Buffer => canonicalJsonBytes({
  v: 1, aad: 'organisation_key', table: 'iam.organisation_keys', id: row.id, organisation_id: row.organisationId,
  purpose: row.purpose, version: row.version, key_version_id: kekVersionId,
});

export function createOrganisationKeyStore(deps: { keys: KeyRing; databases: Databases; logger: Logger; now?: () => number }): OrganisationKeyStore {
  const pool = deps.databases.pool('control');
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { id: string; key: Buffer; expiresAt: number }>();
  const slot = (organisationId: string, purpose: string, version: number): string => `${organisationId}:${purpose}:${version}`;

  const recall = (name: string): { id: string; key: Buffer } | undefined => {
    const entry = cache.get(name);
    if (entry === undefined) return undefined;
    if (entry.expiresAt > now()) return entry;
    zeroise(entry.key);
    cache.delete(name);
    return undefined;
  };

  async function unwrap(row: Row & { dekWrapped: Buffer; keyVersionId: string }): Promise<{ id: string; key: Buffer }> {
    const wrapper = await deps.keys.version(row.keyVersionId);
    const key = await wrapper.unwrap(row.dekWrapped, organisationKeyWrapContext(row, row.keyVersionId));
    if (key.length !== KEY_BYTES) {
      zeroise(key);
      throw new AppError('integrity', 'the organisation key has the wrong length', { code: 'crypto.organisation_key_length' });
    }
    const name = slot(row.organisationId, row.purpose, row.version);
    zeroise(cache.get(name)?.key);
    const entry = { id: row.id, key, expiresAt: now() + CACHE_MS };
    cache.set(name, entry);
    return entry;
  }

  async function create(organisationId: string, purpose: OrganisationKeyPurpose): Promise<void> {
    const key = randomBytes(KEY_BYTES);
    try {
      const wrapper = await deps.keys.active();
      await inTransaction(pool, { organisationId }, async (db) => {
        const row: Row = { id: uuidv7(), organisationId, purpose, version: (await organisationKeyRepo.highestVersion(db, organisationId, purpose)) + 1 };
        await organisationKeyRepo.insert(db, {
          ...row, dekWrapped: await wrapper.wrap(key, organisationKeyWrapContext(row, wrapper.keyVersionId)), keyVersionId: wrapper.keyVersionId,
          status: 'active', activatedAt: new Date(now()).toISOString(),
        });
        deps.logger.info('organisation key created', { event: 'credential.organisation_key_created', organisationId, resourceId: row.id, outcome: purpose });
      });
    } catch (error) {
      // Created at the same moment elsewhere: the active-key index refused this one.
      if (fromDatabaseError(error).category !== 'conflict') throw error;
    } finally {
      zeroise(key);
    }
  }

  return {
    async active(organisationId, purpose) {
      const read = () => inTransaction(pool, { organisationId }, (db) => organisationKeyRepo.findActive(db, organisationId, purpose), { readOnly: true });
      let row = await read();
      if (row === undefined) {
        await create(organisationId, purpose);
        row = await read();
        if (row === undefined) throw new AppError('integrity', 'the organisation has no active key', { code: 'crypto.no_organisation_key' });
      }
      const found = recall(slot(organisationId, purpose, row.version)) ?? await unwrap(row);
      return { id: found.id, version: row.version, key: found.key };
    },

    async atVersion(organisationId, purpose, version) {
      const hit = recall(slot(organisationId, purpose, version));
      if (hit !== undefined) return hit.key;
      const row = await inTransaction(pool, { organisationId }, (db) =>
        organisationKeyRepo.findByPurposeAndVersion(db, { organisationId, purpose, version }), { readOnly: true });
      if (row === undefined || row.status === 'retired') {
        throw new AppError('integrity', 'sealed under a key this organisation no longer holds', { code: 'crypto.organisation_key_unknown' });
      }
      return (await unwrap(row)).key;
    },

    close() {
      for (const entry of cache.values()) zeroise(entry.key);
      cache.clear();
    },
  };
}
