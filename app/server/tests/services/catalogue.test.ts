// The catalogue end to end (spec 16.2): browsing Silo's prebuilt connectors and the
// organisation's own, and a signed release of prebuilt connectors. Real catalogue, registry,
// policy, auth and credential processes; the release path on a migration login, as deployed.
// The marketplace (16.5: community promotion, its review, tiers above it, revenue share) was
// dropped on 2026-11-23: the database refuses a community connector or tier.

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { browseCatalogue, installCatalogueRelease, type CatalogueRelease } from '../../src/contracts/catalogue/catalogue.contract.ts';
import { createConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { service as catalogueService } from '../../src/routes/catalogue/index.route.ts';
import { catalogueMessage } from '../../src/services/catalogue/catalogue.service.ts';
import { keyIdOf } from '../../src/services/fleet-control/signing.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, restManifest, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let fleet: ServiceClient;
let root: Signed;
const dir = mkdtempSync(path.join(tmpdir(), 'silo-catalogue-'));
const keys = generateKeyPairSync('ed25519');

before(async () => {
  writeFileSync(path.join(dir, 'catalogue.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  cell = await createConnectCell();
  await cell.start(catalogueService, 'catalogue', 'test_app', {
    CATALOGUE_DATABASE_URL: cell.h.url('test_migrate'), CATALOGUE_RELEASE_PUBLIC_KEY_FILE: path.join(dir, 'catalogue.pub'),
  });
  gateway = cell.client('gateway');
  fleet = cell.client('fleet-control');
  root = await cell.signIn('root@acme.example');
});

after(async () => {
  await cell?.close();
  rmSync(dir, { recursive: true, force: true });
});

const document = (version = '1.0.0') => ({
  ...restManifest({ baseUrl: 'https://{params.tenant}.crm.example', version, params: [{ name: 'tenant', label: 'Tenant' }] }),
  mapping: [{ object: 'contacts', field: 'email', objectType: 'Customer', property: 'Email', confidence: 0.9 }],
});

async function privateConnector(slug: string): Promise<{ connectorId: string; connectionId: string }> {
  const connector = await gateway.call(createConnector, { body: { slug, name: 'Tenant CRM', provider: 'Example', sourceRoute: 'ai' } },
    { ...cell.as(root), idempotencyKey: uuidv7() });
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: document() } }, { ...cell.as(root), idempotencyKey: uuidv7() });
  const connection = await gateway.call(createConnection, {
    body: { connectorId: connector.id, name: 'CRM', owningScopeId: cell.scopes['engineering']!, parameters: { tenant: 'acme' } },
  }, { ...cell.as(root), idempotencyKey: uuidv7() });
  return { connectorId: connector.id, connectionId: connection.id };
}

const asMigrate = async (sql: string, values: unknown[]) => {
  const db = await cell.h.connect('test_migrate');
  try {
    return (await db.query(sql, values)).rows;
  } finally {
    await db.end();
  }
};

describe('browsing (spec 16.2)', () => {
  let source: { connectorId: string; connectionId: string };

  before(async () => {
    source = await privateConnector('tenant-crm');
  });

  test('the catalogue shows this organisation\'s private connectors, marked as its own', async () => {
    const { connectors } = await gateway.call(browseCatalogue, { query: { tier: 'private' } }, cell.as(root));
    const entry = connectors.find((c) => c.id === source.connectorId)!;
    assert.equal(entry.authoredHere, true);
    assert.deepEqual([entry.current?.version, entry.current?.protocol], ['1.0.0', 'rest']);
    assert.equal((await gateway.call(browseCatalogue, { query: { q: 'nothing like this' } }, cell.as(root))).connectors.length, 0);
  });

  test('no marketplace: there is no community connector or tier, and a private connector\'s tier never changes', async () => {
    await assert.rejects(asMigrate(
      `insert into connect.connectors (id, kind, slug, name, provider, trust_tier, source_route, status) values ($1, 'community', 'shared-crm', 'Shared', 'Example', 'community', 'ai', 'active')`,
      [uuidv7()]), /check constraint|violates/);
    await assert.rejects(asMigrate(`update connect.connectors set trust_tier = 'certified' where id = $1`, [source.connectorId]), /frozen|freeze|cannot|immutable/i);
  });
});

describe('prebuilt connectors from a signed release (spec 16.2)', () => {
  const release = (version = '1.0.0', extra: Partial<CatalogueRelease['connectors'][number]> = {}): CatalogueRelease => ({
    version: '2026.11.1',
    connectors: [{ slug: 'example-crm', name: 'Example CRM', provider: 'Example', document: restManifest({ baseUrl: 'https://api.crm.example', version }) as never, ...extra }],
  });
  const signed = (r: CatalogueRelease, key = keys.privateKey) => ({
    release: r, signature: sign(null, catalogueMessage(r), key).toString('base64url'), keyId: keyIdOf(keys.publicKey),
  });

  test('a verified release installs whole; installing it again changes nothing', async () => {
    assert.deepEqual(await fleet.call(installCatalogueRelease, { body: signed(release()) }), { installed: 1, unchanged: 0 });
    assert.deepEqual(await fleet.call(installCatalogueRelease, { body: signed(release()) }), { installed: 0, unchanged: 1 });
    const { connectors } = await gateway.call(browseCatalogue, { query: { kind: 'prebuilt' } }, cell.as(root));
    assert.deepEqual(connectors.map((c) => [c.slug, c.trustTier, c.authoredHere, c.current?.version]), [['example-crm', 'certified', false, '1.0.0']]);
    assert.deepEqual(await fleet.call(installCatalogueRelease, { body: signed(release('1.1.0')) }), { installed: 1, unchanged: 0 });
  });

  test('refused whole: a signature that does not verify, a changed version, a manifest that fails', async () => {
    const forged = generateKeyPairSync('ed25519');
    await assert.rejects(fleet.call(installCatalogueRelease, { body: signed(release('2.0.0'), forged.privateKey) }), { code: 'catalogue.signature_invalid' });
    const tampered = signed(release('2.0.0'));
    await assert.rejects(fleet.call(installCatalogueRelease, { body: { ...tampered, release: release('2.0.1') } }), { code: 'catalogue.signature_invalid' });
    await assert.rejects(fleet.call(installCatalogueRelease, { body: signed(release('1.0.0', { name: 'Example CRM', document: { ...restManifest({ baseUrl: 'https://other.crm.example', version: '1.0.0' }) } as never })) }),
      { code: 'catalogue.version_changed' });
    await assert.rejects(fleet.call(installCatalogueRelease, { body: signed(release('3.0.0', { document: { schemaVersion: '1' } as never })) }),
      { code: 'catalogue.release_manifest_invalid' });
    await assert.rejects(gateway.call(installCatalogueRelease, { body: signed(release()) }), { code: 'caller.not_listed' });
  });
});
