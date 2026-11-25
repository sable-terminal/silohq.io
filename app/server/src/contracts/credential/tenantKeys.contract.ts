// An organisation's own keys across a tenant migration (spec 6.4, 61). Record values at
// rest (receipts, prior states, diffs, captured transitions) are sealed under the
// organisation's data key, and the entity graph's hashes are keyed by its HMAC key; both
// are wrapped by the cell KEK, which never leaves the source cell. So the keys travel,
// not the values: the source's credential service seals each key to the destination's
// import key, and the destination's credential service opens it in its KMS and wraps it
// under its own KEK. A key is never in plaintext outside a credential service. Every
// sealed value then moves untouched and opens in the destination.
//
// Credentials are different: "Credentials are never migrated, because they are sealed
// under the source cell's keys; every connection is re-authorised" (spec 6.4). Nothing
// here touches connection credentials, identity provider secrets or MFA secrets.
//
// Each sealed key binds what it is: canonical JSON of the migration, organisation, row id,
// purpose, version and the key itself, so a key sealed for one migration or row is
// refused for another.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const base64 = z.string().max(4096).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64');
const pem = z.string().max(4096).regex(/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/, 'a PEM public key');

export const transferredKey = z.strictObject({
  id: z.uuid(),
  purpose: z.enum(['data', 'hmac']),
  version: z.int().min(1),
  status: z.enum(['active', 'decrypt_only', 'retired']),
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
  /** The key and its binding, sealed to the destination's import key (utils/importKey.util.ts). */
  sealed: base64,
});
export type TransferredKey = z.infer<typeof transferredKey>;

/** The public half of this cell's import key, which a source cell seals a migration to. */
export const tenantImportKey = defineContract({
  service: 'credential', name: 'tenantImportKey', method: 'GET', path: '/v1/tenant-import-key',
  callers: ['tenant-migrations'],
  context: 'none', idempotency: 'none',
  response: z.object({
    /** SHA-256 of the key's SubjectPublicKeyInfo, hex: tenant_migrations.destination_key_id. */
    keyId: z.string().regex(/^[0-9a-f]{64}$/),
    publicKey: z.string(),
  }),
});

/**
 * The destination: the key of a migration bundle, sealed to this cell's import key by the
 * source (canonical JSON {aad: tenant_bundle, migration_id, key}). The bundle key protects
 * only the bundle, which tenant-migrations reads to load; the organisation's own keys
 * inside it stay sealed and go to importOrganisationKeys.
 */
export const openTenantBundleKey = defineContract({
  service: 'credential', name: 'openTenantBundleKey', method: 'POST', path: '/v1/tenant-bundle-keys/open',
  callers: ['tenant-migrations'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({ migrationId: z.uuid(), sealedKey: base64 }),
  response: z.object({ key: base64 }),
  maxBodyBytes: 8_192,
});

/** The source: the organisation's keys, each sealed to the destination's import key. */
export const exportOrganisationKeys = defineContract({
  service: 'credential', name: 'exportOrganisationKeys', method: 'POST', path: '/v1/organisation-keys/export',
  callers: ['tenant-migrations'],
  // Sealing again gives new ciphertext and changes nothing stored.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ migrationId: z.uuid(), destinationKey: pem }),
  response: z.object({ keys: z.array(transferredKey) }),
  maxBodyBytes: 8_192,
});

/** The destination: opens each key in this cell's KMS and wraps it under this cell's KEK. */
export const importOrganisationKeys = defineContract({
  service: 'credential', name: 'importOrganisationKeys', method: 'POST', path: '/v1/organisation-keys/import',
  callers: ['tenant-migrations'],
  // A key already imported (same row id) is left as it is and counted.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ migrationId: z.uuid(), keys: z.array(transferredKey).max(1_000) }),
  response: z.object({ imported: z.int(), alreadyPresent: z.int() }),
  maxBodyBytes: 1_048_576,
});
