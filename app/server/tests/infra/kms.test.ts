// Key management (spec 61): Vault transit and the local key, through the envelope
// scheme; the start-up refusal when a key is missing or unusable; and the Vault policy
// (vault/credential.policy.hcl), which can use keys but never create or delete one.
// Here the root token stands in for Terraform, creating the keys and the policy.

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, describe, test } from 'node:test';
import {
  assertKeyAvailable, createKeyManagement, keyRing, startupKeyCheck, type KeyManagement, type KeyRegistry,
} from '../../src/infra/kms.infra.ts';
import { seal, sealBindings, withOpened } from '../../src/utils/envelope.util.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';
import { sealToImportKey } from '../../src/utils/importKey.util.ts';
import { LOCAL } from './services.helper.ts';

const keyName = `silo-test-${Date.now()}`;
const signingKeyName = `${keyName}-signing`;
const importKeyName = `${keyName}-import`;
const missingKeyName = `${keyName}-missing`;
let policyToken = '';

async function vaultRequest(method: string, path: string, token: string, body?: object)
  : Promise<{ status: number; json: Record<string, any> }> {
  const response = await fetch(`${LOCAL.vaultAddr}/v1/${path}`, {
    method, headers: { 'x-vault-token': token, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

const asRoot = (path: string, body: object): Promise<{ status: number }> => vaultRequest('POST', path, LOCAL.vaultToken, body);

before(async () => {
  await asRoot('sys/mounts/transit', { type: 'transit' });
  assert.ok([200, 204].includes((await asRoot(`transit/keys/${keyName}`, { type: 'aes256-gcm96' })).status));
  assert.ok([200, 204].includes((await asRoot(`transit/keys/${signingKeyName}`, { type: 'ed25519' })).status));
  assert.ok([200, 204].includes((await asRoot(`transit/keys/${importKeyName}`, { type: 'rsa-3072' })).status));
  const policy = await readFile(new URL('../../vault/credential.policy.hcl', import.meta.url), 'utf8');
  assert.ok([200, 204].includes((await asRoot('sys/policies/acl/silo-credential', { policy })).status));
  const token = await vaultRequest('POST', 'auth/token/create', LOCAL.vaultToken, {
    policies: ['silo-credential'], no_default_policy: true, ttl: '10m',
  });
  policyToken = String(token.json['auth']?.client_token);
});

const registry = (id: string, keyUri: string): KeyRegistry => ({
  active: async () => ({ id, keyUri }),
  byId: async (wanted) => (wanted === id ? { id, keyUri, status: 'active' } : undefined),
  usable: async () => [{ id, keyUri }],
});

const vaultKms = (token: string): Promise<KeyManagement> =>
  createKeyManagement({ provider: 'vault_transit', vaultAddr: LOCAL.vaultAddr, vaultToken: token, vaultTransitMount: 'transit' });

const providers: [string, () => Promise<{ kms: KeyManagement; keyUri: string; importKeyUri: string }>][] = [
  // Under the credential policy, as the service would run.
  ['vault_transit', async () => ({ kms: await vaultKms(policyToken), keyUri: `vault-transit:${keyName}`, importKeyUri: `vault-transit:${importKeyName}` })],
  ['local', async () => ({
    kms: await createKeyManagement({ provider: 'local', localKey: randomBytes(32), vaultTransitMount: 'transit' }),
    keyUri: 'local:test', importKeyUri: 'local:import',
  })],
];

for (const [name, make] of providers) {
  describe(`kms: ${name}`, () => {
    test('wraps and unwraps a data key, bound to its context', async () => {
      const { kms, keyUri } = await make();
      const wrapper = kms.wrapper({ id: uuidv7(), keyUri });
      const dek = randomBytes(32);
      const context = Buffer.from('row-a');
      const wrapped = await wrapper.wrap(dek, context);
      assert.deepEqual(await wrapper.unwrap(wrapped, context), dek);
      await assert.rejects(wrapper.unwrap(wrapped, Buffer.from('row-b')), { category: 'integrity' });
    });

    test('seals and opens a credential through the envelope scheme', async () => {
      const { kms, keyUri } = await make();
      const ring = keyRing(kms, registry(uuidv7(), keyUri));
      await assertKeyAvailable(ring);
      const binding = sealBindings.connectionCredential({
        id: uuidv7(), organisationId: uuidv7(), connectionId: uuidv7(), fieldName: 'password', purpose: 'connection_auth',
      });
      const sealed = await seal(ring, Buffer.from('hunter2'), binding);
      const { value } = await withOpened(ring, sealed, binding, async (plaintext) => plaintext.toString());
      assert.equal(value, 'hunter2');
    });

    test('computes a keyed MAC inside the provider', async () => {
      const { kms, keyUri } = await make();
      const a = await kms.mac(keyUri, Buffer.from('ada@acme.example'));
      assert.equal(a.length, 32);
      assert.deepEqual(await kms.mac(keyUri, Buffer.from('ada@acme.example')), a);
      assert.notDeepEqual(await kms.mac(keyUri, Buffer.from('bob@acme.example')), a);
    });

    test('opens what another cell sealed to its import key, and nothing else (spec 6.4)', async () => {
      const { kms, keyUri, importKeyUri } = await make();
      assert.equal(await kms.verifyKey(importKeyUri, 'import'), 'ok');
      if (name === 'vault_transit') assert.equal(await kms.verifyKey(keyUri, 'import'), 'unusable', 'an AES key is not an import key');
      const publicKey = await kms.importPublicKey(importKeyUri);
      const secret = randomBytes(32);
      assert.deepEqual(await kms.importDecrypt(importKeyUri, sealToImportKey(publicKey, secret)), secret);
      const elsewhere = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
      await assert.rejects(kms.importDecrypt(importKeyUri, sealToImportKey(elsewhere, secret)), { category: 'integrity' });
    });
  });
}

describe('kms startup', () => {
  test('refuses to start when the key cannot be used (spec 61.1)', async () => {
    const kms = await createKeyManagement({ provider: 'vault_transit', vaultAddr: 'http://127.0.0.1:9', vaultToken: LOCAL.vaultToken, vaultTransitMount: 'transit' });
    const ring = keyRing(kms, registry(uuidv7(), `vault-transit:${keyName}`));
    await assert.rejects(assertKeyAvailable(ring), { category: 'configuration', code: 'kms.startup_refused' });
    const denied = await createKeyManagement({ provider: 'vault_transit', vaultAddr: LOCAL.vaultAddr, vaultToken: 'not-a-token', vaultTransitMount: 'transit' });
    await assert.rejects(assertKeyAvailable(keyRing(denied, registry(uuidv7(), `vault-transit:${keyName}`))),
      { category: 'configuration', code: 'kms.startup_refused' });
  });

  test('there is no PKCS#11 adapter to fall back to', async () => {
    await assert.rejects(createKeyManagement({ provider: 'pkcs11_hsm', vaultTransitMount: 'transit' }), { category: 'configuration' });
  });

  test('a retired key version does not open', async () => {
    const kms = await createKeyManagement({ provider: 'local', localKey: randomBytes(32), vaultTransitMount: 'transit' });
    const id = uuidv7();
    const ring = keyRing(kms, {
      active: async () => ({ id, keyUri: 'local:a' }), byId: async () => ({ id, keyUri: 'local:a', status: 'retired' }), usable: async () => [],
    });
    await assert.rejects(ring.version(id), { category: 'integrity' });
  });

  test('passes when every key exists and can do its job', async () => {
    const kms = await vaultKms(policyToken);
    await startupKeyCheck(kms, registry(uuidv7(), `vault-transit:${keyName}`), [`vault-transit:${keyName}`]);
  });

  test('refuses to start when a configured key is missing, naming it', async () => {
    const kms = await vaultKms(policyToken);
    const versions: KeyRegistry = {
      active: async () => ({ id: 'a', keyUri: `vault-transit:${keyName}` }),
      byId: async () => undefined,
      usable: async () => [{ id: 'a', keyUri: `vault-transit:${keyName}` }, { id: 'b', keyUri: `vault-transit:${missingKeyName}` }],
    };
    await assert.rejects(startupKeyCheck(kms, versions), (error: Error & { category?: string; code?: string }) => {
      assert.equal(error.category, 'configuration');
      assert.equal(error.code, 'kms.keys_missing');
      assert.match(error.message, new RegExp(`${missingKeyName} \\(wrap\\): missing`));
      assert.doesNotMatch(error.message, new RegExp(`${keyName} \\(`));
      return true;
    });
    // The check read the key's metadata and left it missing.
    assert.equal((await vaultRequest('GET', `transit/keys/${missingKeyName}`, LOCAL.vaultToken)).status, 404);
  });

  test('refuses a wrap key that cannot encrypt with associated data', async () => {
    const kms = await vaultKms(policyToken);
    assert.equal(await kms.verifyKey(`vault-transit:${signingKeyName}`, 'wrap'), 'unusable');
    await assert.rejects(startupKeyCheck(kms, registry(uuidv7(), `vault-transit:${signingKeyName}`)), { code: 'kms.keys_missing' });
  });

  test('refuses to start with no key version at all', async () => {
    const kms = await createKeyManagement({ provider: 'local', localKey: randomBytes(32), vaultTransitMount: 'transit' });
    const empty: KeyRegistry = {
      active: async () => { throw new Error('none'); }, byId: async () => undefined, usable: async () => [],
    };
    await assert.rejects(startupKeyCheck(kms, empty), { code: 'kms.keys_missing' });
  });

  test('a token that cannot read key metadata is a configuration error', async () => {
    const created = await vaultRequest('POST', 'auth/token/create', LOCAL.vaultToken, { policies: ['default'], ttl: '10m' });
    const kms = await vaultKms(String(created.json['auth']?.client_token));
    await assert.rejects(kms.verifyKey(`vault-transit:${keyName}`, 'wrap'), { category: 'configuration', code: 'kms.vault_transit.policy' });
  });
});

describe('vault policy (keys come from Terraform only)', () => {
  test('cannot create a key', async () => {
    const created = await vaultRequest('POST', `transit/keys/${missingKeyName}`, policyToken, { type: 'aes256-gcm96' });
    assert.equal(created.status, 403);
  });

  test('encrypting under a missing key fails and does not create it', async () => {
    const upsert = await vaultRequest('POST', `transit/encrypt/${missingKeyName}`, policyToken, { plaintext: 'aGk=' });
    assert.equal(upsert.status, 403);
    assert.equal((await vaultRequest('GET', `transit/keys/${missingKeyName}`, LOCAL.vaultToken)).status, 404);
  });

  test('cannot delete, rotate or reconfigure a key', async () => {
    assert.equal((await vaultRequest('DELETE', `transit/keys/${keyName}`, policyToken)).status, 403);
    assert.equal((await vaultRequest('POST', `transit/keys/${keyName}/rotate`, policyToken, {})).status, 403);
    assert.equal((await vaultRequest('POST', `transit/keys/${keyName}/config`, policyToken, { deletion_allowed: true })).status, 403);
  });

  test('can read key metadata and use the key', async () => {
    assert.equal((await vaultRequest('GET', `transit/keys/${keyName}`, policyToken)).status, 200);
    assert.equal((await vaultRequest('POST', `transit/encrypt/${keyName}`, policyToken, { plaintext: 'aGk=' })).status, 200);
  });
});
