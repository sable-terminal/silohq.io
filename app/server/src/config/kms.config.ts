// The key management service holding the cell's key-encryption keys (spec 8.4, 61).
// Which KEK version wraps is recorded in iam.kms_key_versions; this section says how to
// reach the provider.
//
// Providers match iam.kms_key_versions.provider. In production (decision 2026-10-29):
// gcp_kms in commercial cells, pkcs11_hsm (the UK HSM) in the sovereign build and on
// premises. The sovereign cell's HSM is a Thales Luna (decision 2026-11-14), reached with
// PKCS11_PROFILE=luna: its partition chosen by token label (an HA group's too), logged in as
// the partition's Crypto User, which uses keys and can never create them, and AES-GCM IVs
// generated in the HSM, as Luna requires in FIPS mode (D206). generic is any other module.
// vault_transit and local are for development and tests only: Vault is not in the spec,
// and a Vault for the sovereign cell would have to be backed by the UK HSM. "Production
// refuses to start without a KMS key. No fallback to a local key" (spec 61.1).

import { z } from 'zod';
import { parseSection, read, readSecret, zKey32, type Env } from './env.config.ts';

export const KMS_PROVIDERS = ['gcp_kms', 'pkcs11_hsm', 'vault_transit', 'local'] as const;
export type KmsProvider = (typeof KMS_PROVIDERS)[number];
export const PKCS11_PROFILES = ['generic', 'luna'] as const;

const schema = z.object({
  provider: z.enum(KMS_PROVIDERS),
  // The directory hashing key (spec 6.2), for the directory service and registration only.
  directoryKeyUri: z.string().optional(),
  // The cell's import key (spec 6.4), for the credential service: the public half is what a
  // source cell seals a tenant migration's keys to; the private half opens them here.
  importKeyUri: z.string().optional(),
  vaultAddr: z.url().optional(),
  vaultToken: z.string().optional(),
  vaultNamespace: z.string().optional(),
  vaultTransitMount: z.string().regex(/^[A-Za-z0-9_-]+$/).default('transit'),
  pkcs11ModulePath: z.string().optional(),
  /** Absent is generic. */
  pkcs11Profile: z.enum(PKCS11_PROFILES).optional(),
  /** The slot by number, or (better where slots move, as Luna's do) by its token's label. */
  pkcs11Slot: z.coerce.number().int().min(0).optional(),
  pkcs11TokenLabel: z.string().min(1).max(32).optional(),
  pkcs11Pin: z.string().optional(),
  localKey: zKey32.optional(),
});

export type KmsConfig = z.output<typeof schema>;

export function loadKmsConfig(env: Env, problems: string[]): KmsConfig | undefined {
  if (read(env, 'KMS_PROVIDER') === undefined) return undefined;
  const parsed = parseSection(schema, {
    provider: read(env, 'KMS_PROVIDER'),
    directoryKeyUri: read(env, 'KMS_DIRECTORY_KEY_URI'),
    importKeyUri: read(env, 'KMS_IMPORT_KEY_URI'),
    vaultAddr: read(env, 'VAULT_ADDR'),
    vaultToken: readSecret(env, 'VAULT_TOKEN', problems),
    vaultNamespace: read(env, 'VAULT_NAMESPACE'),
    vaultTransitMount: read(env, 'VAULT_TRANSIT_MOUNT'),
    pkcs11ModulePath: read(env, 'PKCS11_MODULE_PATH'),
    pkcs11Profile: read(env, 'PKCS11_PROFILE'),
    pkcs11Slot: read(env, 'PKCS11_SLOT'),
    pkcs11TokenLabel: read(env, 'PKCS11_TOKEN_LABEL'),
    pkcs11Pin: readSecret(env, 'PKCS11_PIN', problems),
    localKey: readSecret(env, 'KMS_LOCAL_KEY', problems),
  }, {
    provider: 'KMS_PROVIDER', directoryKeyUri: 'KMS_DIRECTORY_KEY_URI', importKeyUri: 'KMS_IMPORT_KEY_URI', vaultAddr: 'VAULT_ADDR',
    vaultToken: 'VAULT_TOKEN', vaultNamespace: 'VAULT_NAMESPACE', vaultTransitMount: 'VAULT_TRANSIT_MOUNT',
    pkcs11ModulePath: 'PKCS11_MODULE_PATH', pkcs11Profile: 'PKCS11_PROFILE', pkcs11Slot: 'PKCS11_SLOT', pkcs11TokenLabel: 'PKCS11_TOKEN_LABEL',
    pkcs11Pin: 'PKCS11_PIN', localKey: 'KMS_LOCAL_KEY',
  }, problems);
  if (!parsed) return undefined;

  const need = (present: unknown, variable: string): void => {
    if (present === undefined) problems.push(`${variable}: required when KMS_PROVIDER=${parsed.provider}`);
  };
  if (parsed.provider === 'vault_transit') {
    need(parsed.vaultAddr, 'VAULT_ADDR');
    need(parsed.vaultToken, 'VAULT_TOKEN');
  }
  if (parsed.provider === 'pkcs11_hsm') {
    need(parsed.pkcs11ModulePath, 'PKCS11_MODULE_PATH');
    need(parsed.pkcs11Pin, 'PKCS11_PIN');
    if ((parsed.pkcs11Slot === undefined) === (parsed.pkcs11TokenLabel === undefined)) {
      problems.push('PKCS11_SLOT, PKCS11_TOKEN_LABEL: name the HSM\'s slot one way, by number or by token label');
    }
    // A Luna partition's slot number moves with the client's configuration and HA groups; its label does not.
    if (parsed.pkcs11Profile === 'luna' && parsed.pkcs11TokenLabel === undefined) {
      problems.push('PKCS11_TOKEN_LABEL: a Luna partition is named by its label (PKCS11_PROFILE=luna)');
    }
  }
  if (parsed.provider !== 'pkcs11_hsm' && read(env, 'PKCS11_PROFILE') !== undefined) {
    problems.push('PKCS11_PROFILE: only for KMS_PROVIDER=pkcs11_hsm');
  }
  if (parsed.provider === 'local') need(parsed.localKey, 'KMS_LOCAL_KEY');
  if (parsed.provider !== 'local' && parsed.localKey !== undefined) {
    problems.push('KMS_LOCAL_KEY: only for KMS_PROVIDER=local');
  }
  return parsed;
}
