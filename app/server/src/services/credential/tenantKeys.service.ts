// An organisation's keys across a tenant migration (contracts/credential/tenantKeys.contract.ts).
// The source seals each key to the destination's import key; the destination opens it in
// its KMS and wraps it under its own KEK. A key is plaintext only inside this process, for
// the moment it is sealed or wrapped, and is zeroed after.

import type { TransferredKey } from '../../contracts/credential/tenantKeys.contract.ts';
import type { KeyManagement } from '../../infra/kms.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import { organisationKeyRepo } from '../../repos/iam/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { KEY_BYTES, zeroise } from '../../utils/crypto.util.ts';
import type { KeyRing } from '../../utils/envelope.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { canonicalImportKey, importKeyId, sealToImportKey } from '../../utils/importKey.util.ts';
import { organisationKeyWrapContext } from './organisationKeyStore.service.ts';

export interface TenantKeys {
  importKey(): Promise<{ keyId: string; publicKey: string }>;
  export(organisationId: string, migrationId: string, destinationKey: string): Promise<TransferredKey[]>;
  import(organisationId: string, migrationId: string, keys: readonly TransferredKey[]): Promise<{ imported: number; alreadyPresent: number }>;
  openBundleKey(migrationId: string, sealedKey: string): Promise<{ key: string }>;
}

interface Binding { migrationId: string; organisationId: string; id: string; purpose: string; version: number }

const sealedDocument = (binding: Binding, key: Buffer): Buffer => canonicalJsonBytes({
  v: 1, aad: 'tenant_key', migration_id: binding.migrationId, organisation_id: binding.organisationId,
  id: binding.id, purpose: binding.purpose, version: binding.version, key: key.toString('base64'),
});

const refused = (): AppError => new AppError('integrity', 'the key was not sealed for this migration, organisation and row', {
  code: 'credential.tenant_key_mismatch',
});

export function createTenantKeys(deps: {
  kms: KeyManagement; importKeyUri: string | undefined; keys: KeyRing; databases: Databases; logger: Logger;
}): TenantKeys {
  const pool = deps.databases.pool('control');
  const importKeyUri = (): string => {
    if (deps.importKeyUri === undefined) {
      throw new AppError('configuration', 'this cell has no import key (KMS_IMPORT_KEY_URI)', { code: 'config.kms.import_key' });
    }
    return deps.importKeyUri;
  };

  return {
    async importKey() {
      const publicKey = canonicalImportKey(await deps.kms.importPublicKey(importKeyUri()));
      return { keyId: importKeyId(publicKey), publicKey };
    },

    async openBundleKey(migrationId, sealedKey) {
      let opened: Buffer;
      try {
        opened = await deps.kms.importDecrypt(importKeyUri(), Buffer.from(sealedKey, 'base64'));
      } catch (cause) {
        throw new AppError('integrity', 'the bundle key was not sealed to this cell\'s import key', { code: 'credential.tenant_key_unopened', cause });
      }
      try {
        const document = JSON.parse(opened.toString('utf8')) as Record<string, unknown>;
        const key = Buffer.from(String(document['key']), 'base64');
        if (document['aad'] !== 'tenant_bundle' || document['migration_id'] !== migrationId || key.length !== KEY_BYTES) throw refused();
        return { key: key.toString('base64') };
      } finally {
        zeroise(opened);
      }
    },

    async export(organisationId, migrationId, destinationKey) {
      const rows = await inTransaction(pool, { organisationId }, (db) => organisationKeyRepo.listForOrganisation(db, organisationId), { readOnly: true });
      const out: TransferredKey[] = [];
      for (const row of rows) {
        const wrapper = await deps.keys.version(row.keyVersionId);
        const key = await wrapper.unwrap(row.dekWrapped, organisationKeyWrapContext(row, row.keyVersionId));
        const document = sealedDocument({ migrationId, organisationId, id: row.id, purpose: row.purpose, version: row.version }, key);
        try {
          out.push({
            id: row.id, purpose: row.purpose, version: row.version, status: row.status, createdAt: row.createdAt,
            activatedAt: row.activatedAt, retiredAt: row.retiredAt, sealed: sealToImportKey(destinationKey, document).toString('base64'),
          });
        } finally {
          zeroise(key, document);
        }
      }
      deps.logger.info('organisation keys sealed for a tenant migration', {
        event: 'credential.tenant_keys_exported', organisationId, resourceId: migrationId, rowCount: out.length,
      });
      return out;
    },

    async import(organisationId, migrationId, keys) {
      let imported = 0;
      let alreadyPresent = 0;
      const uri = importKeyUri();
      for (const transferred of keys) {
        const present = await inTransaction(pool, { organisationId }, (db) => organisationKeyRepo.findById(db, transferred.id), { readOnly: true });
        if (present !== undefined) {
          if (present.purpose !== transferred.purpose || present.version !== transferred.version) throw refused();
          alreadyPresent += 1;
          continue;
        }
        let opened: Buffer;
        try {
          opened = await deps.kms.importDecrypt(uri, Buffer.from(transferred.sealed, 'base64'));
        } catch (cause) {
          throw new AppError('integrity', 'the key was not sealed to this cell\'s import key', { code: 'credential.tenant_key_unopened', cause });
        }
        let key: Buffer | undefined;
        try {
          const document = JSON.parse(opened.toString('utf8')) as Record<string, unknown>;
          if (document['aad'] !== 'tenant_key' || document['migration_id'] !== migrationId || document['organisation_id'] !== organisationId
            || document['id'] !== transferred.id || document['purpose'] !== transferred.purpose || document['version'] !== transferred.version) {
            throw refused();
          }
          key = Buffer.from(String(document['key']), 'base64');
          if (key.length !== KEY_BYTES) throw refused();
          const wrapper = await deps.keys.active();
          const row = { id: transferred.id, organisationId, purpose: transferred.purpose, version: transferred.version };
          const dekWrapped = await wrapper.wrap(key, organisationKeyWrapContext(row, wrapper.keyVersionId));
          await inTransaction(pool, { organisationId }, (db) => organisationKeyRepo.insert(db, {
            ...row, dekWrapped, keyVersionId: wrapper.keyVersionId, status: transferred.status,
            createdAt: transferred.createdAt, activatedAt: transferred.activatedAt, retiredAt: transferred.retiredAt,
          }));
          imported += 1;
        } finally {
          zeroise(opened, key);
        }
      }
      deps.logger.info('organisation keys wrapped under this cell\'s KEK', {
        event: 'credential.tenant_keys_imported', organisationId, resourceId: migrationId, rowCount: imported,
      });
      return { imported, alreadyPresent };
    },
  };
}
