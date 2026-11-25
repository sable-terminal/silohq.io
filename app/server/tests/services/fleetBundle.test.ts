// Air-gapped bundles loaded into an install's own fleet-control (spec 11.4; D201): Silo's
// fleet-control registers and signs a release and its bundle; on the media go the signed
// release, its documents and its images; the install's fleet-control checks the whole bundle
// before loading anything, refuses it whole on any mismatch (bundle_refused), and otherwise
// loads the release exactly as Silo signed it, its documents into the artefact store, records
// bundle_verified and makes the release the head of the install's channel.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config/index.config.ts';
import type { ReleaseManifest } from '../../src/contracts/fleet-control/release.contract.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { openDatabases, type Databases } from '../../src/infra/postgres.infra.ts';
import { openFleetControl } from '../../src/services/fleet-control/control.service.ts';
import { ARTEFACTS_DIR, BUNDLE_FILE, describeBundleFiles, SIGNATURES_FILE } from '../../src/services/fleet-control/bundle.service.ts';
import type { Fleet } from '../../src/services/fleet-control/fleet.service.ts';
import { keyIdOf } from '../../src/services/fleet-control/signing.service.ts';
import { createHarness, type Harness } from '../db/harness.helper.ts';

const quiet = createLogger({ service: 'fleet-control', cell: 'test', release: 'test', level: 'error', write: () => undefined });
const pem = (key: KeyObject): string => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

let silo: { h: Harness; databases: Databases; fleet: Fleet };
let install: { h: Harness; databases: Databases; fleet: Fleet; store: string };
let root: string;
const releaseKeys = generateKeyPairSync('ed25519');
const operator = randomUUID();
const approver = randomUUID();

async function fleetOn(h: Harness, artefacts: string, key: KeyObject, extra: Record<string, string>) {
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'fleet-control', SILO_CELL_ID: 'onprem-1', SILO_CELL_KIND: 'self_managed', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
    PG_DIRECTORY_URL: h.url('test_fleet', 'directory'), FLEET_ARTEFACT_DIR: artefacts, FLEET_SIGNING_KEY: pem(key), ...extra,
  });
  const databases = openDatabases(config.postgres, 'fleet-control', ['directory']);
  return { databases, fleet: (await openFleetControl(config, databases, quiet)).fleet };
}

/** A bundle on the media as Silo's build makes it: the signed release, its documents and images, the manifest of hashes, signed. */
async function bundle(releaseId: string, tamper?: (dir: string) => Promise<void>): Promise<string> {
  const documents = ['config', 'flags', 'routes'].map((text) => Buffer.from(`${releaseId}/${text}`));
  const manifest: ReleaseManifest = {
    schema: 'silo.release.v1', releaseId, target: 'commercial', cellTemplateVersion: '1.0.0',
    images: [{ service: 'auth', digest: `sha256:${hex(`${releaseId}/auth`)}`, sbom: { format: 'spdx', digest: `sha256:${hex('sbom')}` } }],
    migrations: [], configurationDigest: `sha256:${hex(documents[0]!)}`, flagsDigest: `sha256:${hex(documents[1]!)}`, modelRoutingDigest: `sha256:${hex(documents[2]!)}`,
    agentBinaries: [], capabilities: ['gcs', 'cloud_kms'], securityFix: false,
    provenance: { sourceCommit: 'e'.repeat(40), builder: 'ci' }, builtAt: '2026-11-19T09:00:00.000Z',
  };
  const signed = await silo.fleet.registerRelease(releaseId, manifest, operator);
  const dir = path.join(root, `bundle-${releaseId}`);
  const artefacts = path.join(dir, ARTEFACTS_DIR);
  await mkdir(path.join(artefacts, 'release-documents'), { recursive: true });
  await mkdir(path.join(artefacts, 'images'), { recursive: true });
  const { registeredAt: _registeredAt, ...release } = signed;
  await writeFile(path.join(artefacts, 'release.json'), JSON.stringify(release));
  for (const document of documents) await writeFile(path.join(artefacts, 'release-documents', hex(document)), document);
  await writeFile(path.join(artefacts, 'images', 'auth.tar'), randomBytes(2048));
  const files = await describeBundleFiles(artefacts);
  const signedBundle = await silo.fleet.signBundle(randomUUID(), { releaseId, fromReleaseId: null, files });
  await writeFile(path.join(dir, BUNDLE_FILE), JSON.stringify(signedBundle.bundle));
  await writeFile(path.join(dir, SIGNATURES_FILE), JSON.stringify(signedBundle.signatures));
  await tamper?.(dir);
  return dir;
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'silo-bundle-'));
  const releasePublic = path.join(root, 'release.pub.pem');
  await writeFile(releasePublic, releaseKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const siloHarness = await createHarness();
  silo = { h: siloHarness, ...(await fleetOn(siloHarness, path.join(root, 'silo'), releaseKeys.privateKey, {})) };
  const installHarness = await createHarness();
  // The install's own fleet-control signs with its own key and trusts Silo's release key.
  install = {
    h: installHarness, store: path.join(root, 'install'),
    ...(await fleetOn(installHarness, path.join(root, 'install'), generateKeyPairSync('ed25519').privateKey, { FLEET_RELEASE_PUBLIC_KEY_FILE: releasePublic })),
  };
  const writer = await installHarness.connect('test_dir_writer', 'directory');
  await writer.query(`insert into directory.cells (id, kind, residency, hostname, status) values ('onprem-1', 'self_managed', 'uk', 'onprem-1.acme.example', 'active')`);
});

after(async () => {
  await silo?.databases.close(1_000);
  await install?.databases.close(1_000);
  await silo?.h.close();
  await install?.h.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('air-gapped bundles (spec 11.4)', () => {
  test('a bundle is checked whole, then its release loaded as Silo signed it and made the head of the install\'s channel, by two people', async () => {
    const dir = await bundle('r-bundle-1');
    await assert.rejects(install.fleet.loadBundle(dir, { operatorId: operator, approverId: operator, channel: 'stable', cellId: 'onprem-1' }), { code: 'fleet.two_person' });
    const loaded = await install.fleet.loadBundle(dir, { operatorId: operator, approverId: approver, channel: 'stable', cellId: 'onprem-1' });
    assert.deepEqual([loaded.releaseId, loaded.files], ['r-bundle-1', 5]);
    const release = await install.fleet.readRelease('r-bundle-1');
    assert.deepEqual(release.signatures.map((s) => s.keyId), [keyIdOf(releaseKeys.publicKey)], 'Silo\'s signature, never signed again by the install');
    const config = await install.fleet.readReleaseDocument(release.manifest.configurationDigest.slice('sha256:'.length));
    assert.equal(Buffer.from(config.data, 'base64').toString(), 'r-bundle-1/config', 'its documents in the install\'s store');
    const desired = await install.fleet.desiredRelease('onprem-1', 'stable');
    assert.equal(desired.releaseId, 'r-bundle-1', 'the install\'s Fleet agent is told to run it');
    const { events } = await install.fleet.listEvents({ after: 0, cellId: 'onprem-1', limit: 100 });
    const verified = events.find((e) => e.event === 'bundle_verified')!;
    assert.deepEqual([verified.releaseId, verified.detail['files']], ['r-bundle-1', 5]);
  });

  test('any mismatch refuses the whole bundle, recorded with why: a file changed, a file added, a signature by another key', async () => {
    const changed = await bundle('r-bundle-2', async (dir) => { await writeFile(path.join(dir, ARTEFACTS_DIR, 'images', 'auth.tar'), randomBytes(2048)); });
    await assert.rejects(install.fleet.loadBundle(changed, { operatorId: operator, approverId: approver, channel: 'stable', cellId: 'onprem-1' }), { code: 'fleet.bundle_refused' });
    const added = await bundle('r-bundle-3', async (dir) => { await writeFile(path.join(dir, ARTEFACTS_DIR, 'images', 'extra.tar'), 'x'); });
    await assert.rejects(install.fleet.loadBundle(added, { operatorId: operator, approverId: approver, channel: 'stable', cellId: 'onprem-1' }), { code: 'fleet.bundle_refused' });
    const forged = await bundle('r-bundle-4', async (dir) => {
      const other = generateKeyPairSync('ed25519');
      await writeFile(path.join(dir, SIGNATURES_FILE), JSON.stringify([{ keyId: keyIdOf(other.publicKey), role: 'release', signature: 'A'.repeat(86) }]));
    });
    await assert.rejects(install.fleet.loadBundle(forged, { operatorId: operator, approverId: approver, channel: 'stable', cellId: 'onprem-1' }), { code: 'fleet.bundle_refused' });
    await assert.rejects(install.fleet.readRelease('r-bundle-2'), { code: 'fleet.release_unknown' }, 'nothing of a refused bundle is loaded');
    const { events } = await install.fleet.listEvents({ after: 0, cellId: 'onprem-1', limit: 100 });
    assert.deepEqual(events.filter((e) => e.event === 'bundle_refused').map((e) => e.detail['reason']), ['hash', 'unlisted_file', 'signature']);
    assert.equal((await install.fleet.desiredRelease('onprem-1', 'stable')).releaseId, 'r-bundle-1', 'the install keeps what it runs');
  });
});
