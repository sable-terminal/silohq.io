// Cloud KMS has no emulator, so this runs against a dedicated throwaway project, in CI on
// main only (decision 2026-10-29). Skipped unless these are set, with Application Default
// Credentials for a service account that may use the keys but not create them:
//   TEST_GCP_KMS_KEY          projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>,
//                             purpose ENCRYPT_DECRYPT
//   TEST_GCP_KMS_MAC_VERSION  .../cryptoKeys/<k>/cryptoKeyVersions/<n>, an HMAC_SHA256 key
//                             (optional; the MAC tests skip without it)

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createKeyManagement, keyRing, startupKeyCheck, type KeyRegistry } from '../../src/infra/kms.infra.ts';
import { seal, sealBindings, withOpened } from '../../src/utils/envelope.util.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';

const key = process.env['TEST_GCP_KMS_KEY'];
const macVersion = process.env['TEST_GCP_KMS_MAC_VERSION'];
const skip = key === undefined ? 'TEST_GCP_KMS_KEY is not set (Cloud KMS runs in CI on main only)' : false;
const skipMac = skip || (macVersion === undefined ? 'TEST_GCP_KMS_MAC_VERSION is not set' : false);

const registry = (keyUri: string): KeyRegistry => {
  const id = uuidv7();
  return {
    active: async () => ({ id, keyUri }),
    byId: async (wanted) => (wanted === id ? { id, keyUri, status: 'active' } : undefined),
    usable: async () => [{ id, keyUri }],
  };
};

const gcp = () => createKeyManagement({ provider: 'gcp_kms', vaultTransitMount: 'transit' });

describe('kms: gcp_kms', { skip }, () => {
  test('wraps and unwraps a data key, bound to its context', async () => {
    const kms = await gcp();
    try {
      const wrapper = kms.wrapper({ id: uuidv7(), keyUri: key! });
      const dek = Buffer.alloc(32, 7);
      const wrapped = await wrapper.wrap(dek, Buffer.from('row-a'));
      assert.deepEqual(await wrapper.unwrap(wrapped, Buffer.from('row-a')), dek);
      await assert.rejects(wrapper.unwrap(wrapped, Buffer.from('row-b')), { category: 'integrity' });
    } finally {
      await kms.close();
    }
  });

  test('seals and opens a credential through the envelope scheme', async () => {
    const kms = await gcp();
    try {
      const ring = keyRing(kms, registry(key!));
      const binding = sealBindings.connectionCredential({
        id: uuidv7(), organisationId: uuidv7(), connectionId: uuidv7(), fieldName: 'password', purpose: 'connection_auth',
      });
      const sealed = await seal(ring, Buffer.from('hunter2'), binding);
      const { value } = await withOpened(ring, sealed, binding, async (plaintext) => plaintext.toString());
      assert.equal(value, 'hunter2');
    } finally {
      await kms.close();
    }
  });

  test('the start-up check passes for the key and refuses a missing one', async () => {
    const kms = await gcp();
    try {
      await startupKeyCheck(kms, registry(key!));
      const missing = `${key!.replace(/\/cryptoKeys\/[^/]+$/, '')}/cryptoKeys/silo-missing-${Date.now()}`;
      assert.equal(await kms.verifyKey(missing, 'wrap'), 'missing');
      await assert.rejects(startupKeyCheck(kms, registry(missing)), { code: 'kms.keys_missing' });
    } finally {
      await kms.close();
    }
  });

  test('computes a keyed MAC inside the provider', { skip: skipMac }, async () => {
    const kms = await gcp();
    try {
      assert.equal(await kms.verifyKey(macVersion!, 'mac'), 'ok');
      const a = await kms.mac(macVersion!, Buffer.from('ada@acme.example'));
      assert.equal(a.length, 32);
      assert.deepEqual(await kms.mac(macVersion!, Buffer.from('ada@acme.example')), a);
      // An encryption key cannot stand in for the MAC key.
      assert.notEqual(await kms.verifyKey(`${key!}/cryptoKeyVersions/1`, 'mac'), 'ok');
    } finally {
      await kms.close();
    }
  });
});
