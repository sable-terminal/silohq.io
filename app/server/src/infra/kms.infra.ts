// Key management: the key-encryption keys that wrap every data key (spec 8.4, 61). The
// KEK never enters the process; wrap, unwrap and MAC run in the provider.
//
// Providers (iam.kms_key_versions.provider):
// - gcp_kms: Cloud KMS, commercial cells. Additional authenticated data binds each
//   wrapped key to its row and key version (spec 61.1).
// - vault_transit: Vault transit, for development only (refused in production by config),
//   with associated data on an AES-GCM key.
// - pkcs11_hsm: an HSM over PKCS#11 (the UK HSM of the sovereign cell, Thales Luna; a
//   customer HSM on premises), through graphene-pk11 (decision 2026-11-14): pkcs11.infra.ts.
//   Cloud HSM in the commercial cells is Cloud KMS at its HSM protection level (gcp_kms).
// - local: a key in configuration, refused outside development and tests (config).
//
// Keys are never created here. At start-up the credential service reads the metadata of
// every key it may use and refuses to start if any is missing (startupKeyCheck). In Vault
// the policy (vault/credential.policy.hcl) grants read on keys and update, never create,
// on encrypt, so a mistyped key name fails instead of Vault creating the key.
//
// key_uri forms: projects/.../cryptoKeys/<key> (gcp_kms), vault-transit:<key name>
// (vault_transit), pkcs11:object=<label> (pkcs11_hsm), local:<label> (local).
//
// The import key (spec 6.4, "encrypt to destination import key"): an asymmetric key whose
// public half another cell seals a tenant migration to (utils/importKey.util.ts). Cloud KMS:
// a key version of purpose ASYMMETRIC_DECRYPT, RSA_DECRYPT_OAEP_*_SHA256 (the URI names
// the version). Vault transit: an rsa-3072 or rsa-4096 key. Local: an X25519 key derived
// from the local key and the URI.

import { pkcs11KeyManagement } from './pkcs11.infra.ts';
import type { KmsConfig, KmsProvider } from '../config/kms.config.ts';
import { hkdfSync } from 'node:crypto';
import { aesGcmOpen, aesGcmSeal, hmacSha256, NONCE_BYTES, randomBytes, zeroise } from '../utils/crypto.util.ts';
import type { KeyRing, KeyWrapper } from '../utils/envelope.util.ts';
import { AppError } from '../utils/errors.util.ts';
import { openX25519, rsaCiphertext, sealedScheme, x25519FromSeed } from '../utils/importKey.util.ts';

export interface KeyVersionRef {
  id: string;
  keyUri: string;
}

export interface KeyManagement {
  readonly provider: KmsProvider;
  wrapper(version: KeyVersionRef): KeyWrapper;
  /** HMAC-SHA-256 inside the provider, for the directory hashing key (spec 6.2). */
  mac(keyUri: string, data: Buffer): Promise<Buffer>;
  /** The import key's public half, SPKI PEM, which another cell seals a tenant migration to. */
  importPublicKey(keyUri: string): Promise<string>;
  /** Opens a value sealed to the import key (importKey.util.ts sealToImportKey), inside the provider. */
  importDecrypt(keyUri: string, sealed: Buffer): Promise<Buffer>;
  /** Whether a key exists and can do this job, read from its metadata. Never creates one. */
  verifyKey(keyUri: string, use: KeyUse): Promise<KeyVerdict>;
  close(): Promise<void>;
}

export type KeyUse = 'wrap' | 'mac' | 'import';
export type KeyVerdict = 'ok' | 'missing' | 'unusable';

const unavailable = (provider: string, cause: unknown): AppError =>
  new AppError('unavailable', `${provider} is unavailable`, { code: `kms.${provider}.unavailable`, cause });
const refusedToOpen = (provider: string, cause?: unknown): AppError =>
  new AppError('integrity', 'the key provider refused to unwrap', { code: `kms.${provider}.unwrap_refused`, cause });

// ----------------------------------------------------------------------------- local

function localKeyManagement(kek: Buffer): KeyManagement {
  const importKey = (keyUri: string) => {
    if (!keyUri.startsWith('local:')) throw new AppError('configuration', 'a local key URI starts local:');
    return x25519FromSeed(Buffer.from(hkdfSync('sha256', kek, Buffer.from('silo.local_import_key.v1'), Buffer.from(keyUri), 32)));
  };
  return {
    provider: 'local',
    wrapper: (version) => {
      if (!version.keyUri.startsWith('local:')) throw new AppError('configuration', 'a local key URI starts local:');
      return {
        keyVersionId: version.id,
        async wrap(dek, context) {
          const sealed = aesGcmSeal(kek, dek, context);
          return Buffer.concat([sealed.nonce, sealed.ciphertext]);
        },
        async unwrap(wrapped, context) {
          return aesGcmOpen(kek, { nonce: wrapped.subarray(0, NONCE_BYTES), ciphertext: wrapped.subarray(NONCE_BYTES) }, context);
        },
      };
    },
    async mac(_keyUri, data) {
      return hmacSha256(kek, data);
    },
    async importPublicKey(keyUri) {
      return importKey(keyUri).publicKeyPem;
    },
    async importDecrypt(keyUri, sealed) {
      try {
        return openX25519(importKey(keyUri).privateKey, sealed);
      } catch (cause) {
        throw refusedToOpen('local', cause);
      }
    },
    async verifyKey(keyUri) {
      return keyUri.startsWith('local:') ? 'ok' : 'missing';
    },
    async close() {
      zeroise(kek);
    },
  };
}

// ----------------------------------------------------------------------------- Vault transit

function vaultKeyName(keyUri: string): string {
  const match = /^vault-transit:([A-Za-z0-9_-]+)$/.exec(keyUri);
  if (!match) throw new AppError('configuration', 'a Vault transit key URI is vault-transit:<key name>');
  return match[1]!;
}

function vaultKeyManagement(config: KmsConfig): KeyManagement {
  const base = `${config.vaultAddr!.replace(/\/$/, '')}/v1/${config.vaultTransitMount}`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-vault-token': config.vaultToken!,
    ...(config.vaultNamespace ? { 'x-vault-namespace': config.vaultNamespace } : {}),
  };
  // The response body is never read into an error: only the status is kept.
  const call = async (path: string, body: object): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetch(`${base}/${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
    } catch (cause) {
      throw unavailable('vault_transit', cause);
    }
    if (response.status === 400 && path.startsWith('decrypt/')) throw refusedToOpen('vault_transit');
    if (!response.ok) {
      throw new AppError(response.status >= 500 ? 'unavailable' : 'configuration', 'Vault transit refused the request', {
        code: 'kms.vault_transit.refused', details: { status: response.status },
      });
    }
    const json = await response.json() as { data?: Record<string, unknown> };
    return json.data ?? {};
  };
  const AEAD = new Set(['aes128-gcm96', 'aes256-gcm96', 'chacha20-poly1305']);
  const readKey = async (name: string): Promise<{ status: number; data: Record<string, unknown> }> => {
    let response: Response;
    try {
      response = await fetch(`${base}/keys/${name}`, { headers, signal: AbortSignal.timeout(5_000) });
    } catch (cause) {
      throw unavailable('vault_transit', cause);
    }
    if (response.status === 403) {
      throw new AppError('configuration', 'the Vault policy must grant read on transit keys', { code: 'kms.vault_transit.policy' });
    }
    const json = response.ok ? await response.json() as { data?: Record<string, unknown> } : {};
    return { status: response.status, data: json.data ?? {} };
  };
  return {
    provider: 'vault_transit',
    wrapper: (version) => {
      const key = vaultKeyName(version.keyUri);
      return {
        keyVersionId: version.id,
        async wrap(dek, context) {
          const data = await call(`encrypt/${key}`, { plaintext: dek.toString('base64'), associated_data: context.toString('base64') });
          return Buffer.from(String(data['ciphertext']), 'utf8');
        },
        async unwrap(wrapped, context) {
          const data = await call(`decrypt/${key}`, { ciphertext: wrapped.toString('utf8'), associated_data: context.toString('base64') });
          return Buffer.from(String(data['plaintext']), 'base64');
        },
      };
    },
    async mac(keyUri, data) {
      const result = await call(`hmac/${vaultKeyName(keyUri)}/sha2-256`, { input: data.toString('base64') });
      return Buffer.from(String(result['hmac']).replace(/^vault:v\d+:/, ''), 'base64');
    },
    async importPublicKey(keyUri) {
      const { status, data } = await readKey(vaultKeyName(keyUri));
      const version = String(data['latest_version']);
      const pem = (data['keys'] as Record<string, { public_key?: string }> | undefined)?.[version]?.public_key;
      if (status !== 200 || typeof pem !== 'string') {
        throw new AppError('configuration', 'the Vault import key has no public key', { code: 'kms.vault_transit.import_key' });
      }
      return pem;
    },
    async importDecrypt(keyUri, sealed) {
      if (sealedScheme(sealed) !== 'rsa_oaep_sha256') throw refusedToOpen('vault_transit');
      const name = vaultKeyName(keyUri);
      const { data } = await readKey(name);
      // Vault opens RSA-OAEP-SHA256 sealed elsewhere when it is framed as its own ciphertext.
      const result = await call(`decrypt/${name}`, { ciphertext: `vault:v${String(data['latest_version'])}:${rsaCiphertext(sealed).toString('base64')}` });
      return Buffer.from(String(result['plaintext']), 'base64');
    },
    async verifyKey(keyUri, use) {
      const { status, data } = await readKey(vaultKeyName(keyUri));
      if (status === 404) return 'missing';
      if (status >= 400) throw new AppError('unavailable', 'Vault transit refused the key read', { code: 'kms.vault_transit.refused', details: { status } });
      if (use === 'wrap' && (!AEAD.has(String(data['type'])) || data['supports_encryption'] !== true)) return 'unusable';
      if (use === 'import' && !/^rsa-(3072|4096)$/.test(String(data['type']))) return 'unusable';
      return 'ok';
    },
    async close() {
      headers['x-vault-token'] = '';
    },
  };
}

// ----------------------------------------------------------------------------- Cloud KMS

async function gcpKeyManagement(): Promise<KeyManagement> {
  // Imported on use: the sovereign build carries no Cloud KMS client (spec 6.5).
  const { KeyManagementServiceClient } = await import('@google-cloud/kms');
  const client = new KeyManagementServiceClient();
  const bytes = (value: Uint8Array | string | null | undefined): Buffer =>
    typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value ?? []);
  return {
    provider: 'gcp_kms',
    wrapper: (version) => ({
      keyVersionId: version.id,
      async wrap(dek, context) {
        try {
          const [response] = await client.encrypt({ name: version.keyUri, plaintext: dek, additionalAuthenticatedData: context });
          return bytes(response.ciphertext);
        } catch (cause) {
          throw unavailable('gcp_kms', cause);
        }
      },
      async unwrap(wrapped, context) {
        try {
          const [response] = await client.decrypt({ name: version.keyUri, ciphertext: wrapped, additionalAuthenticatedData: context });
          return bytes(response.plaintext);
        } catch (cause) {
          // INVALID_ARGUMENT (3) is a wrong key or wrong associated data, not an outage.
          if ((cause as { code?: unknown }).code === 3) throw refusedToOpen('gcp_kms', cause);
          throw unavailable('gcp_kms', cause);
        }
      },
    }),
    async mac(keyUri, data) {
      try {
        const [response] = await client.macSign({ name: keyUri, data });
        return bytes(response.mac);
      } catch (cause) {
        throw unavailable('gcp_kms', cause);
      }
    },
    async importPublicKey(keyUri) {
      try {
        const [response] = await client.getPublicKey({ name: keyUri });
        return String(response.pem);
      } catch (cause) {
        throw unavailable('gcp_kms', cause);
      }
    },
    async importDecrypt(keyUri, sealed) {
      if (sealedScheme(sealed) !== 'rsa_oaep_sha256') throw refusedToOpen('gcp_kms');
      try {
        const [response] = await client.asymmetricDecrypt({ name: keyUri, ciphertext: rsaCiphertext(sealed) });
        return bytes(response.plaintext);
      } catch (cause) {
        if ((cause as { code?: unknown }).code === 3) throw refusedToOpen('gcp_kms', cause);
        throw unavailable('gcp_kms', cause);
      }
    },
    async verifyKey(keyUri, use) {
      try {
        if (use === 'import') {
          // An import key URI names a key version (asymmetric decryption uses one version).
          const [version] = await client.getCryptoKeyVersion({ name: keyUri });
          return version.state === 'ENABLED' && /^RSA_DECRYPT_OAEP_(3072|4096)_SHA256$/.test(String(version.algorithm)) ? 'ok' : 'unusable';
        }
        if (use === 'mac') {
          // A MAC key URI names a key version (macSign signs with one version).
          const [version] = await client.getCryptoKeyVersion({ name: keyUri });
          return version.state === 'ENABLED' && String(version.algorithm).startsWith('HMAC_') ? 'ok' : 'unusable';
        }
        const [key] = await client.getCryptoKey({ name: keyUri });
        return key.purpose === 'ENCRYPT_DECRYPT' && key.primary?.state === 'ENABLED' ? 'ok' : 'unusable';
      } catch (cause) {
        if ((cause as { code?: unknown }).code === 5) return 'missing';
        throw unavailable('gcp_kms', cause);
      }
    },
    async close() {
      await client.close();
    },
  };
}

export async function createKeyManagement(config: KmsConfig): Promise<KeyManagement> {
  switch (config.provider) {
    case 'local':
      return localKeyManagement(Buffer.from(config.localKey!));
    case 'vault_transit':
      return vaultKeyManagement(config);
    case 'gcp_kms':
      return gcpKeyManagement();
    case 'pkcs11_hsm':
      return pkcs11KeyManagement(config);
  }
}

// The cell's key versions, read from iam.kms_key_versions through the caller's queries
// (the credential service's repo), so infra holds no SQL.
export interface KeyRegistry {
  active(): Promise<KeyVersionRef>;
  byId(id: string): Promise<(KeyVersionRef & { status: 'active' | 'decrypt_only' | 'retired' }) | undefined>;
  /** Every version that may still open a secret: active and decrypt_only. */
  usable(): Promise<KeyVersionRef[]>;
}

export function keyRing(kms: KeyManagement, registry: KeyRegistry): KeyRing {
  return {
    async active() {
      return kms.wrapper(await registry.active());
    },
    async version(keyVersionId) {
      const version = await registry.byId(keyVersionId);
      if (version === undefined || version.status === 'retired') {
        throw new AppError('integrity', 'the key version that wrapped this secret is not available', {
          code: 'kms.key_version_unavailable', details: { keyVersionId },
        });
      }
      return kms.wrapper(version);
    },
  };
}

// The start-up check of the credential service (decision 2026-10-29): every key the cell
// may use is read from its provider's metadata, and the process refuses to start if any
// is missing or cannot do its job, so a mistyped key name fails at deploy time. Then a
// round trip under the active key proves it works. Never creates a key: in Vault the
// policy denies create and delete on transit keys, and keys come only from Terraform.
export async function startupKeyCheck(kms: KeyManagement, registry: KeyRegistry, macKeyUris: string[] = []): Promise<void> {
  const keys: [string, KeyUse][] = [
    ...(await registry.usable()).map((v): [string, KeyUse] => [v.keyUri, 'wrap']),
    ...macKeyUris.map((uri): [string, KeyUse] => [uri, 'mac']),
  ];
  const problems: string[] = [];
  for (const [keyUri, use] of keys) {
    const verdict = await kms.verifyKey(keyUri, use);
    if (verdict !== 'ok') problems.push(`${keyUri} (${use}): ${verdict}`);
  }
  if (keys.length === 0) problems.push('no key version is active');
  if (problems.length > 0) {
    throw new AppError('configuration', `KMS keys not usable, refusing to start: ${problems.join('; ')}`, {
      code: 'kms.keys_missing', details: { problems: problems.length },
    });
  }
  await assertKeyAvailable(keyRing(kms, registry));
}

// "Production refuses to start without a KMS key" (spec 61.1): a wrap and unwrap round
// trip under the active version, run at startup by the credential service. On failure
// the caller writes startup_refused_no_kms_key (spec 61.9) and exits.
export async function assertKeyAvailable(ring: KeyRing): Promise<void> {
  const probe = randomBytes(32);
  const context = Buffer.from('silo.kms_probe.v1');
  try {
    const wrapper = await ring.active();
    const opened = await wrapper.unwrap(await wrapper.wrap(probe, context), context);
    if (!opened.equals(probe)) throw new Error('round trip mismatch');
    zeroise(opened);
  } catch (cause) {
    throw new AppError('configuration', 'no usable KMS key: refusing to start (spec 61.1)', { code: 'kms.startup_refused', cause });
  } finally {
    zeroise(probe);
  }
}
