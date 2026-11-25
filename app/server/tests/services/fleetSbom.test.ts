// SBOM checks (spec 11.1: "SBOMs are checked for vulnerabilities daily; a critical one in a
// reachable component blocks stable"), through a real fleet-control process on a fresh
// directory database and an advisory feed laid out as osv.dev's exports, served over HTTP:
// a release passes dev and canary, then stable refuses it until its SBOMs are in, the feeds
// are synced, and every critical finding is fixed or stated not affected by VEX; an
// incremental sync raises one advisory to critical and withdraws another; an agent channel
// refuses on a stale feed until it syncs again.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { loadConfig } from '../../src/config/index.config.ts';
import { registerRelease, type ReleaseManifest } from '../../src/contracts/fleet-control/release.contract.ts';
import { approvePromotion, GATES, readRollout, reportVerdict, requestPromotion, type RolloutView } from '../../src/contracts/fleet-control/rollout.contract.ts';
import { putReleaseSbom, putReleaseVex, readReleaseFindings, syncAdvisories } from '../../src/contracts/fleet-control/sbom.contract.ts';
import { createAdvisorySource } from '../../src/infra/advisoryFeed.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createFleetService } from '../../src/routes/fleet-control/index.route.ts';
import { putAgentBinary } from '../../src/scripts/putAgentBinary.script.ts';
import { directoryArtefactStore } from '../../src/services/fleet-control/artefactStore.service.ts';
import { putReleaseDocument } from '../../src/scripts/putReleaseDocument.script.ts';
import { createHarness, uuidv7, type Harness } from '../db/harness.helper.ts';
import { zipOf } from '../utils/zipWriter.helper.ts';

const HOUR = 3_600_000;
const PASS = GATES.map((gate) => ({ gate, passed: true }));
const hex = (text: string): string => createHash('sha256').update(text).digest('hex');
const pem = (key: KeyObject): string => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const quiet = createLogger({ service: 'fleet-control', cell: 'global-uk', release: 'test', level: 'error', write: () => undefined });
const engineers = { a: uuidv7(), b: uuidv7(), officer: uuidv7() };
const releaseKeys = generateKeyPairSync('ed25519');

let clock = Date.parse('2026-11-02T09:00:00Z');
let h: Harness;
let root: string;
let feedDir: string;
let feedServer: Server;
let fleet: RunningProcess;
let portal: ServiceClient;
let agent: ServiceClient;

const sboms = {
  'image:auth': JSON.stringify({
    bomFormat: 'CycloneDX', specVersion: '1.5', components: [
      { purl: 'pkg:npm/left-pad@1.2.0' }, { purl: 'pkg:npm/%40scope/pkg@2.0.5' }, { purl: 'pkg:npm/evil@1.0.0' },
      { purl: 'pkg:npm/lodash@4.17.21' }, { purl: 'pkg:rpm/redhat/curl@7.61' }, { name: 'no purl' },
    ],
  }),
  'image:policy': JSON.stringify({
    spdxVersion: 'SPDX-2.3', packages: [{ name: 'openssl', externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl',
      referenceLocator: 'pkg:deb/debian/openssl@3.0.11-1~deb12u1?distro=debian-12' }] }],
  }),
  'agent:linux_x86_64': JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [{ purl: 'pkg:npm/left-pad@1.3.0' }] }),
};

const manifest: ReleaseManifest = {
  schema: 'silo.release.v1', releaseId: 'rA', target: 'commercial', cellTemplateVersion: '1.0.0',
  images: [
    { service: 'auth', digest: `sha256:${hex('rA/auth')}`, sbom: { format: 'cyclonedx', digest: `sha256:${hex(sboms['image:auth'])}` } },
    { service: 'policy', digest: `sha256:${hex('rA/policy')}`, sbom: { format: 'spdx', digest: `sha256:${hex(sboms['image:policy'])}` } },
  ],
  migrations: [], configurationDigest: `sha256:${hex('c')}`, flagsDigest: `sha256:${hex('f')}`, modelRoutingDigest: `sha256:${hex('m')}`,
  agentBinaries: [{ platform: 'linux_x86_64', version: '1.0.0', digest: `sha256:${hex('rA/agent')}`,
    sbom: { format: 'cyclonedx', digest: `sha256:${hex(sboms['agent:linux_x86_64'])}` } }],
  capabilities: ['gcs', 'cloud_kms'], securityFix: false, provenance: { sourceCommit: 'b'.repeat(40), builder: 'ci' },
  builtAt: new Date(clock).toISOString(),
};

const osv = (id: string, modified: number, extra: Record<string, unknown>) => ({ schema_version: '1.6.0', id, modified: new Date(modified).toISOString(), ...extra });
const semver = (name: string, introduced: string, fixed: string) => ({
  package: { ecosystem: 'npm', name }, ranges: [{ type: 'SEMVER', events: [{ introduced }, { fixed }] }],
});

async function writeFeed(ecosystem: string, records: Record<string, unknown>[], options: { zip64?: boolean } = {}): Promise<void> {
  await mkdir(path.join(feedDir, ecosystem), { recursive: true });
  const files = records.map((r) => ({ name: `${String(r['id'])}.json`, body: Buffer.from(JSON.stringify(r)) }));
  await writeFile(path.join(feedDir, ecosystem, 'all.zip'), zipOf(files, options));
  for (const f of files) await writeFile(path.join(feedDir, ecosystem, f.name), f.body);
  const newest = [...records].sort((a, b) => Date.parse(String(b['modified'])) - Date.parse(String(a['modified'])));
  await writeFile(path.join(feedDir, ecosystem, 'modified_id.csv'), newest.map((r) => `${String(r['modified'])},${String(r['id'])}\n`).join(''));
}

const promote = async (channel: string) => {
  const promotionId = uuidv7();
  const requested = await portal.call(requestPromotion, { params: { promotionId }, body: { releaseId: 'rA', channel: channel as never, requestedBy: engineers.a, expedite: false } });
  if (requested.state === 'applied') return requested;
  return portal.call(approvePromotion, { params: { promotionId }, body: { approvedBy: engineers.b } });
};
const verdict = (rolloutId: string, cellId: string) => agent.call(reportVerdict, { params: { rolloutId, cellId }, body: { releaseId: 'rA', gates: PASS } });
async function waitFor<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) assert.fail(`did not get there: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const rollout = (rolloutId: string) => portal.call(readRollout, { params: { rolloutId } });
const findings = () => portal.call(readReleaseFindings, { params: { releaseId: 'rA' } });
const upload = (subject: keyof typeof sboms) =>
  portal.call(putReleaseSbom, { params: { releaseId: 'rA', sha256: hex(sboms[subject]) }, body: { document: sboms[subject], operatorId: engineers.a } });
/** Every feed synced and the release checked again, a minute on, so the wait sees this sync's results. */
async function synced(): Promise<void> {
  clock += 60_000;
  const at = new Date(clock).toISOString();
  await portal.call(syncAdvisories, { body: { operatorId: engineers.a } });
  await waitFor(findings, (f) => f.checkedAt === at && f.feeds.length > 0 && f.feeds.every((x) => x.lastSyncedAt === at));
}

before(async () => {
  h = await createHarness();
  const writer: pg.Client = await h.connect('test_dir_writer', 'directory');
  for (const id of ['test-1', 'uk-lon-canary']) {
    await writer.query(`insert into directory.cells (id, kind, residency, hostname, status) values ($1, 'commercial', 'uk', $2, 'active')`, [id, `${id}.silohq.io`]);
  }
  root = await mkdtemp(path.join(tmpdir(), 'silo-fleet-sbom-'));
  feedDir = path.join(root, 'feed');
  const t0 = clock - 10 * 24 * HOUR;
  await writeFeed('npm', [
    osv('GHSA-crit', t0, { aliases: ['CVE-2026-0001'], severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }], affected: [semver('left-pad', '0', '1.3.0')] }),
    osv('GHSA-high', t0, { database_specific: { severity: 'HIGH' }, affected: [semver('@scope/pkg', '2.0.0', '2.1.0')] }),
    osv('MAL-2026-0001', t0, { affected: [{ package: { ecosystem: 'npm', name: 'evil' }, versions: ['1.0.0'] }] }),
    osv('GHSA-alias', t0, { aliases: ['CVE-2026-0002'], database_specific: { severity: 'CRITICAL' }, affected: [semver('unused-pkg', '0', '9.9.9')] }),
  ], { zip64: true });
  await writeFeed('Debian', [
    osv('DEBIAN-CVE-2026-0002', t0, { aliases: ['CVE-2026-0002'], affected: [{ package: { ecosystem: 'Debian:12', name: 'openssl' },
      ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '3.0.11-1~deb12u2' }] }] }] }),
  ]);
  feedServer = createServer((req, res) => {
    void (async () => {
      let body: Buffer;
      try {
        body = await readFile(path.join(feedDir, decodeURIComponent(new URL(req.url!, 'http://feed').pathname)));
      } catch {
        res.writeHead(404).end();
        return;
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (range !== null) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), body.length - 1);
        res.writeHead(206, { 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${body.length}` });
        res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { 'content-length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    })();
  });
  await new Promise<void>((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  const port = (feedServer.address() as { port: number }).port;
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'fleet-control', SILO_CELL_ID: 'global-uk', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
    PG_DIRECTORY_URL: h.url('test_fleet', 'directory'), FLEET_TEST_CELLS: 'test-1', FLEET_CANARY_CELLS: 'uk-lon-canary',
    FLEET_ARTEFACT_DIR: path.join(root, 'artefacts'), FLEET_SIGNING_KEY: pem(releaseKeys.privateKey), FLEET_ADVISORY_URL: `http://127.0.0.1:${port}`,
  });
  for (const text of ['c', 'f', 'm']) await putReleaseDocument(directoryArtefactStore(path.join(root, 'artefacts')), Buffer.from(text));
  fleet = await runProcess([createFleetService({ now: () => clock, tickMs: 50 })], config, { logger: quiet });
  const http = { ...config.http, serviceUrls: { 'fleet-control': `http://127.0.0.1:${fleet.port}` } };
  portal = createServiceClient({ caller: 'admin-portal', http });
  agent = createServiceClient({ caller: 'fleet-control', http });
});

after(async () => {
  portal?.close();
  agent?.close();
  await fleet?.stop('test');
  await new Promise((resolve) => feedServer?.close(resolve));
  await h?.close();
  await rm(root, { recursive: true, force: true });
});

describe('SBOM checks before stable (spec 11.1)', () => {
  test('the release passes dev and canary as before', async () => {
    await portal.call(registerRelease, { params: { releaseId: 'rA' }, body: { manifest, operatorId: engineers.a } });
    // The build put the agent binary in the store (an agent channel takes the release only then).
    await putAgentBinary(directoryArtefactStore(path.join(root, 'artefacts')), Buffer.from('rA/agent'));
    const dev = await promote('dev');
    await verdict(dev.rolloutId!, 'test-1');
    await waitFor(() => rollout(dev.rolloutId!), (r: RolloutView) => r.status === 'completed');
    const canary = await promote('canary');
    await verdict(canary.rolloutId!, 'test-1');
    clock += 4 * HOUR;
    await waitFor(() => rollout(canary.rolloutId!), (r: RolloutView) => r.waves[1]!.startedAt !== null);
    await verdict(canary.rolloutId!, 'uk-lon-canary');
    clock += 48 * HOUR;
    await waitFor(() => rollout(canary.rolloutId!), (r: RolloutView) => r.status === 'completed');
  });

  test('stable refuses until the SBOMs are in and their feeds synced; an SBOM is the signed one or nothing', async () => {
    await assert.rejects(promote('stable'), { code: 'fleet.sbom_missing' });
    const auth = sboms['image:auth'];
    await assert.rejects(portal.call(putReleaseSbom, { params: { releaseId: 'rA', sha256: hex('other') }, body: { document: auth, operatorId: engineers.a } }),
      { code: 'fleet.document_digest_mismatch' });
    const stray = JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [] });
    await assert.rejects(portal.call(putReleaseSbom, { params: { releaseId: 'rA', sha256: hex(stray) }, body: { document: stray, operatorId: engineers.a } }),
      { code: 'fleet.sbom_not_in_release' });

    const received = await upload('image:auth');
    assert.deepEqual([received.subject, received.components, received.unmatched, received.withoutPurl, received.findings],
      ['image:auth', 5, 1, 1, 0], 'nothing is known to affect it before the feeds sync');
    assert.equal((await upload('image:auth')).components, 5, 'received again, nothing changes');
    await upload('image:policy');
    await assert.rejects(promote('stable'), { code: 'fleet.advisories_stale' });
  });

  test('after the sync, critical findings block; VEX statements from the security officer clear them', async () => {
    await synced();
    const found = await findings();
    const by = new Map(found.findings.map((f) => [`${f.advisoryId} ${f.purl}`, f]));
    assert.deepEqual([...by.keys()].sort(), [
      'DEBIAN-CVE-2026-0002 pkg:deb/debian/openssl@3.0.11-1~deb12u1?distro=debian-12', 'GHSA-crit pkg:npm/left-pad@1.2.0',
      'GHSA-high pkg:npm/%40scope/pkg@2.0.5', 'MAL-2026-0001 pkg:npm/evil@1.0.0',
    ]);
    assert.deepEqual([by.get('GHSA-crit pkg:npm/left-pad@1.2.0')!.severity, by.get('GHSA-crit pkg:npm/left-pad@1.2.0')!.score], ['critical', 9.8]);
    assert.equal(by.get('GHSA-high pkg:npm/%40scope/pkg@2.0.5')!.blocking, false, 'high, not critical');
    assert.equal(by.get('MAL-2026-0001 pkg:npm/evil@1.0.0')!.severity, 'critical', 'a malicious package is critical');
    const debian = by.get('DEBIAN-CVE-2026-0002 pkg:deb/debian/openssl@3.0.11-1~deb12u1?distro=debian-12')!;
    assert.deepEqual([debian.severity, debian.blocking], ['critical', true], 'unrated itself, rated by the GHSA sharing its CVE');
    assert.equal(found.blocking, 3);
    await assert.rejects(promote('stable'), (error: { code?: string; details?: { advisories?: string } }) =>
      error.code === 'fleet.sbom_blocking' && error.details?.advisories === 'DEBIAN-CVE-2026-0002,GHSA-crit,MAL-2026-0001');

    const vex = JSON.stringify({
      '@context': 'https://openvex.dev/ns/v0.2.0', statements: [
        { vulnerability: { name: 'GHSA-crit' }, status: 'not_affected', justification: 'vulnerable_code_not_in_execute_path',
          products: [{ '@id': 'pkg:oci/auth', subcomponents: [{ '@id': 'pkg:npm/left-pad@1.2.0' }] }] },
        { vulnerability: { name: 'CVE-2026-0002' }, status: 'fixed', products: [{ '@id': 'pkg:deb/debian/openssl' }] },
        { vulnerability: 'MAL-2026-0001', status: 'not_affected', impact_statement: 'vendored for its tests; never loaded',
          products: [{ '@id': 'pkg:npm/evil@1.0.0' }] },
      ],
    });
    const stated = await portal.call(putReleaseVex, { params: { releaseId: 'rA', sha256: hex(vex) }, body: { document: vex, operatorId: engineers.officer } });
    assert.deepEqual([stated.statements, stated.blocking, stated.findings], [3, 0, 4]);
    assert.equal((await findings()).findings.find((f) => f.advisoryId === 'GHSA-crit')!.vexStatus, 'not_affected');
    assert.equal((await promote('stable')).state, 'applied');
  });

  test('an incremental sync raises an advisory to critical and withdraws another', async () => {
    clock += HOUR;
    const t0 = clock - 10 * 24 * HOUR;
    await writeFeed('npm', [
      osv('GHSA-crit', t0, { aliases: ['CVE-2026-0001'], severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }], affected: [semver('left-pad', '0', '1.3.0')] }),
      osv('GHSA-high', clock, { database_specific: { severity: 'CRITICAL' }, affected: [semver('@scope/pkg', '2.0.0', '2.1.0')] }),
      osv('MAL-2026-0001', clock, { withdrawn: new Date(clock).toISOString(), affected: [{ package: { ecosystem: 'npm', name: 'evil' }, versions: ['1.0.0'] }] }),
      osv('GHSA-alias', t0, { aliases: ['CVE-2026-0002'], database_specific: { severity: 'CRITICAL' }, affected: [semver('unused-pkg', '0', '9.9.9')] }),
    ]);
    // Only the changed records are fetched: the whole export no longer matches what was mirrored, and is not read.
    await writeFile(path.join(feedDir, 'npm', 'all.zip'), 'not read');
    await synced();
    const found = await findings();
    assert.deepEqual(found.findings.filter((f) => f.blocking).map((f) => f.advisoryId), ['GHSA-high']);
    assert.ok(!found.findings.some((f) => f.advisoryId === 'MAL-2026-0001'), 'a withdrawn advisory clears its finding');
  });

  test('an agent channel checks the agent binaries\' SBOMs, and refuses on a stale feed until it syncs', async () => {
    await assert.rejects(promote('agent-stable'), (error: { code?: string; details?: { missing?: string } }) =>
      error.code === 'fleet.sbom_missing' && error.details?.missing === 'agent:linux_x86_64');
    assert.equal((await upload('agent:linux_x86_64')).blocking, 1, 'the image finding still stands; the agent has none');
    clock += 49 * HOUR;
    await assert.rejects(promote('agent-stable'), { code: 'fleet.advisories_stale' });
    await synced();
    assert.equal((await promote('agent-stable')).state, 'applied', 'left-pad 1.3.0 is the fixed version');
  });

  test('a feed copied in on media reads the same as one served', async () => {
    const copy = createAdvisorySource(pathToFileURL(feedDir).href);
    const lines: string[] = [];
    for await (const line of copy.lines('Debian/modified_id.csv')) lines.push(line);
    assert.deepEqual(lines.map((l) => l.split(',')[1]), ['DEBIAN-CVE-2026-0002']);
    assert.equal(JSON.parse((await copy.text('Debian/DEBIAN-CVE-2026-0002.json'))!).id, 'DEBIAN-CVE-2026-0002');
    assert.equal(await copy.text('Debian/none.json'), undefined);
    const size = (await copy.size('Debian/all.zip'))!;
    assert.equal((await copy.read('Debian/all.zip', 0, 4)).readUInt32LE(0), 0x04034b50);
    assert.ok(size > 22);
  });
});
