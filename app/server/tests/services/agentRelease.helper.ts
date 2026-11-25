// Agent releases through a real fleet-control for the agent update tests: the global tier's
// fleet-control on the harness's directory database, with a release key, an artefact store
// and an advisory feed on disk, and a release taken through dev and canary to agent-stable,
// its binaries put in the store as the build would.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../src/config/index.config.ts';
import { registerRelease, type ReleaseManifest } from '../../src/contracts/fleet-control/release.contract.ts';
import { approvePromotion, GATES, readRollout, reportVerdict, requestPromotion, type RolloutView } from '../../src/contracts/fleet-control/rollout.contract.ts';
import { putReleaseSbom } from '../../src/contracts/fleet-control/sbom.contract.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createFleetService } from '../../src/routes/fleet-control/index.route.ts';
import { putAgentBinary } from '../../src/scripts/putAgentBinary.script.ts';
import { putReleaseDocument } from '../../src/scripts/putReleaseDocument.script.ts';
import { directoryArtefactStore } from '../../src/services/fleet-control/artefactStore.service.ts';
import type { Harness } from '../db/harness.helper.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { zipOf } from '../utils/zipWriter.helper.ts';

const HOUR = 3_600_000;
const PASS = GATES.map((gate) => ({ gate, passed: true }));
export const sha = (data: string | Buffer): string => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const pem = (key: KeyObject): string => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const quiet = createLogger({ service: 'fleet-control', cell: 'global-uk', release: 'test', level: 'error', write: () => undefined });
const cdx = (subject: string): string => JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { component: { name: subject } }, components: [] });

export interface ReleaseFleet {
  port: number;
  /** Release engineers, through admin-portal; and a cell's Fleet agent. */
  portal: ServiceClient;
  fleetAgent: ServiceClient;
  releaseKeys: { publicKey: KeyObject; privateKey: KeyObject };
  /** The release public key, SPKI PEM, on disk. */
  releasePublicFile: string;
  /** The release public key as the agent build takes it: base64 SPKI DER. */
  releaseKeyForAgent: string;
  manifestOf(releaseId: string, version: string, binaries: Record<string, Buffer>): ReleaseManifest;
  promote(releaseId: string, channel: string): Promise<{ state: string; rolloutId: string | null }>;
  /** A release through dev and canary to agent-stable; its binaries put in the store first unless held back. */
  release(releaseId: string, version: string, binaries: Record<string, Buffer>, options?: { holdBinaries?: boolean }): Promise<void>;
  putBinary(bytes: Buffer): Promise<void>;
  close(): Promise<void>;
}

export async function startReleaseFleet(h: Harness, dir: string): Promise<ReleaseFleet> {
  let clock = Date.parse('2026-11-17T09:00:00Z');
  const engineers = { a: uuidv7(), b: uuidv7() };
  const releaseKeys = generateKeyPairSync('ed25519');
  const releasePublicFile = path.join(dir, 'release.pub.pem');
  await writeFile(releasePublicFile, releaseKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const writer = await h.connect('test_dir_writer', 'directory');
  for (const id of ['test-1', 'uk-lon-canary']) {
    await writer.query(`insert into directory.cells (id, kind, residency, hostname, status) values ($1, 'commercial', 'uk', $2, 'active')
      on conflict do nothing`, [id, `${id}.silohq.io`]);
  }
  await writer.end();
  await mkdir(path.join(dir, 'feed', 'npm'), { recursive: true });
  await writeFile(path.join(dir, 'feed', 'npm', 'all.zip'), zipOf([]));
  await writeFile(path.join(dir, 'feed', 'npm', 'modified_id.csv'), '');
  const artefacts = path.join(dir, 'artefacts');
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'fleet-control', SILO_CELL_ID: 'global-uk', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
    PG_DIRECTORY_URL: h.url('test_fleet', 'directory'), FLEET_TEST_CELLS: 'test-1', FLEET_CANARY_CELLS: 'uk-lon-canary',
    FLEET_ARTEFACT_DIR: artefacts, FLEET_SIGNING_KEY: pem(releaseKeys.privateKey), FLEET_ADVISORY_URL: pathToFileURL(path.join(dir, 'feed')).href,
  });
  for (const text of ['config', 'flags', 'routes']) await putReleaseDocument(directoryArtefactStore(artefacts), Buffer.from(text));
  const fleet: RunningProcess = await runProcess([createFleetService({ now: () => clock, tickMs: 50 })], config, { logger: quiet });
  const http = { ...config.http, serviceUrls: { 'fleet-control': `http://127.0.0.1:${fleet.port}` } };
  const portal = createServiceClient({ caller: 'admin-portal', http });
  const fleetAgent = createServiceClient({ caller: 'fleet-control', http });

  const promote = async (releaseId: string, channel: string) => {
    const promotionId = uuidv7();
    const requested = await portal.call(requestPromotion, { params: { promotionId }, body: { releaseId, channel: channel as never, requestedBy: engineers.a } });
    if (requested.state === 'applied') return requested;
    return portal.call(approvePromotion, { params: { promotionId }, body: { approvedBy: engineers.b } });
  };
  const verdict = (rolloutId: string, cellId: string, releaseId: string) =>
    fleetAgent.call(reportVerdict, { params: { rolloutId, cellId }, body: { releaseId, gates: PASS } });
  const rolloutIn = async (rolloutId: string, check: (r: RolloutView) => boolean): Promise<void> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const r = await portal.call(readRollout, { params: { rolloutId } });
      if (check(r)) return;
      if (Date.now() > deadline) assert.fail(`the fleet rollout did not get there: ${JSON.stringify(r)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const manifestOf = (releaseId: string, version: string, binaries: Record<string, Buffer>): ReleaseManifest => ({
    schema: 'silo.release.v1', releaseId, target: 'commercial', cellTemplateVersion: '1.0.0',
    images: [{ service: 'auth', digest: sha(`${releaseId}/auth`), sbom: { format: 'spdx', digest: sha(`${releaseId}/auth/sbom`) } }],
    migrations: [], configurationDigest: sha('config'), flagsDigest: sha('flags'), modelRoutingDigest: sha('routes'),
    agentBinaries: Object.entries(binaries).map(([platform, bytes]) => ({
      platform: platform as never, version, digest: sha(bytes), sbom: { format: 'cyclonedx' as const, digest: sha(cdx(`${releaseId}/${platform}`)) },
    })),
    capabilities: ['gcs', 'cloud_kms'], securityFix: false,
    provenance: { sourceCommit: 'c'.repeat(40), builder: 'ci' }, builtAt: new Date(clock).toISOString(),
  });
  const putBinary = async (bytes: Buffer): Promise<void> => { await putAgentBinary(directoryArtefactStore(artefacts), bytes); };

  return {
    port: fleet.port, portal, fleetAgent, releaseKeys, releasePublicFile,
    releaseKeyForAgent: releaseKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    manifestOf, promote, putBinary,
    async release(releaseId, version, binaries, options = {}) {
      await portal.call(registerRelease, { params: { releaseId }, body: { manifest: manifestOf(releaseId, version, binaries), operatorId: engineers.a } });
      const dev = await promote(releaseId, 'dev');
      await verdict(dev.rolloutId!, 'test-1', releaseId);
      await rolloutIn(dev.rolloutId!, (r) => r.status === 'completed');
      const canary = await promote(releaseId, 'canary');
      await verdict(canary.rolloutId!, 'test-1', releaseId);
      clock += 4 * HOUR;
      await rolloutIn(canary.rolloutId!, (r) => r.waves[1]!.startedAt !== null);
      await verdict(canary.rolloutId!, 'uk-lon-canary', releaseId);
      clock += 48 * HOUR;
      await rolloutIn(canary.rolloutId!, (r) => r.status === 'completed');
      for (const platform of Object.keys(binaries)) {
        const document = cdx(`${releaseId}/${platform}`);
        await portal.call(putReleaseSbom, { params: { releaseId, sha256: sha(document).slice(7) }, body: { document, operatorId: engineers.a } });
      }
      if (options.holdBinaries) return;
      for (const bytes of Object.values(binaries)) await putBinary(bytes);
      assert.equal((await promote(releaseId, 'agent-stable')).state, 'applied');
    },
    async close() {
      portal.close();
      fleetAgent.close();
      await fleet.stop('test');
    },
  };
}
