// The cell's Fleet agent applying the cell's releases (spec 11.1 to 11.3), against a real
// global fleet-control and a fake Kubernetes API: a release checked with the Silo release key,
// its migrations run as a Job that alone mounts the migration role's Secret and reported
// applied, its configuration, flags and model routing kept by digest, its images rolled by
// digest one service at a time, one zone first, fleet-control last; what the cell runs kept in
// a ConfigMap; a failed migration or a stalled roll fails the release, reported as a failing
// verdict, the rollout halts and the cell goes back to the release before with no schema change.

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config/index.config.ts';
import { listFleetEvents } from '../../src/contracts/fleet-control/events.contract.ts';
import { registerRelease, type ReleaseManifest } from '../../src/contracts/fleet-control/release.contract.ts';
import { GATES, readRollout, reportVerdict } from '../../src/contracts/fleet-control/rollout.contract.ts';
import { createKubernetesClient } from '../../src/infra/kubernetes.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createFleetService } from '../../src/routes/fleet-control/index.route.ts';
import { createCellReleases, type CellReleases } from '../../src/services/fleet-control/cellRelease.service.ts';
import { trustedKey } from '../../src/services/fleet-control/signing.service.ts';
import { createSignalStore, DEFAULT_GATE_SETTINGS, type SignalStore } from '../../src/services/fleet-control/cellSignals.service.ts';
import { reportProcessSignals, type ProcessSignals } from '../../src/contracts/fleet-control/signals.contract.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { service as expressionEvaluator } from '../../src/routes/expression-evaluator/index.route.ts';
import type { SyntheticGate } from '../../src/services/fleet-control/cellRelease.service.ts';
import { createHarness, uuidv7, type Harness } from '../db/harness.helper.ts';
import { sha, startReleaseFleet, type ReleaseFleet } from './agentRelease.helper.ts';
import { startFakeKubernetes, type FakeKubernetes } from './fakeKubernetes.helper.ts';
import { createMemoryStore } from './memoryStore.helper.ts';
import { createServer, type Server } from 'node:http';
import { putReleaseDocument } from '../../src/scripts/putReleaseDocument.script.ts';
import { directoryArtefactStore } from '../../src/services/fleet-control/artefactStore.service.ts';

const REPO = 'registry.example/silo/cells';
const quiet = createLogger({ service: 'fleet-control', cell: 'test-1', release: 'test', level: 'error', write: () => undefined });

let h: Harness;
let dir: string;
let fleet: ReleaseFleet;
let kube: FakeKubernetes;
let agent: RunningProcess;
let releases: CellReleases;
let store: SignalStore;
let reporter: ServiceClient;
let synthetic: Partial<Record<SyntheticGate, boolean>> | undefined;
/** What the catalogue stub was asked to install. */
const catalogueBodies: unknown[] = [];
let catalogueStub: Server;

const manifestOf = (releaseId: string, migrations: string[]): ReleaseManifest => ({
  schema: 'silo.release.v1', releaseId, target: 'commercial', cellTemplateVersion: '1.0.0',
  images: (['auth', 'fleet-control', 'policy'] as const).map((service) => ({ service, digest: sha(`${releaseId}/${service}`), sbom: { format: 'spdx' as const, digest: sha(`${releaseId}/${service}/sbom`) } })),
  migrations: migrations.map((name, i) => ({ database: 'cell' as const, version: String(i + 1).padStart(4, '0'), name, digest: sha(`migration/${name}`) })),
  configurationDigest: sha('config'), flagsDigest: sha('flags'), modelRoutingDigest: sha('routes'),
  agentBinaries: [], capabilities: ['gcs', 'cloud_kms'], securityFix: false,
  provenance: { sourceCommit: 'd'.repeat(40), builder: 'ci' }, builtAt: '2026-11-18T09:00:00.000Z',
});

/** A release registered and promoted to dev, whose one wave is the test cell. */
async function onDev(releaseId: string, migrations: string[]): Promise<string> {
  await fleet.portal.call(registerRelease, { params: { releaseId }, body: { manifest: manifestOf(releaseId, migrations), operatorId: uuidv7() } });
  const promoted = await fleet.promote(releaseId, 'dev');
  return promoted.rolloutId!;
}

const patched = (since: number) => kube.calls.slice(since).filter((c) => c.method === 'PATCH' && c.path.includes('/deployments/')).map((c) => c.path.split('/').at(-1));
const state = async () => releases.readState();

before(async () => {
  h = await createHarness();
  dir = await mkdtemp(path.join(tmpdir(), 'silo-cell-release-'));
  fleet = await startReleaseFleet(h, dir);
  kube = await startFakeKubernetes([
    { name: 'auth-b', service: 'auth', zone: 'europe-west2-b', image: `${REPO}/auth@${sha('r0/auth')}` },
    { name: 'auth-a', service: 'auth', zone: 'europe-west2-a', image: `${REPO}/auth@${sha('r0/auth')}` },
    { name: 'policy-a', service: 'policy', zone: 'europe-west2-a', image: `${REPO}/policy@${sha('r0/policy')}` },
    { name: 'fleet-control-a', service: 'fleet-control', zone: 'europe-west2-a', image: `${REPO}/fleet-control@${sha('r0/fleet-control')}` },
  ]);
  catalogueStub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      catalogueBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ installed: 1, unchanged: 0 }));
    });
  });
  await new Promise<void>((resolve) => catalogueStub.listen(0, '127.0.0.1', resolve));
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'fleet-control', SILO_CELL_ID: 'test-1', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
    FLEET_ROLE: 'cell_agent', FLEET_RELEASE_PUBLIC_KEY_FILE: fleet.releasePublicFile, FLEET_AGENT_POLL_MINUTES: '600', FLEET_RELEASE_POLL_MINUTES: '600',
    FLEET_KUBERNETES: kube.url, FLEET_KUBERNETES_NAMESPACE: 'silo', FLEET_IMAGE_REPOSITORY: REPO, FLEET_CHANNEL: 'dev',
    SERVICE_URL_FLEET_CONTROL: `http://127.0.0.1:${fleet.port}`, SERVICE_URL_CATALOGUE: `http://127.0.0.1:${(catalogueStub.address() as { port: number }).port}`,
    OBJECT_STORE: 's3', OBJECT_BUCKET_FILES: 'silo-test-files', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true',
  });
  agent = await runProcess([createFleetService({
    objects: createMemoryStore(), checkEveryMs: 10, onCellReleases: (r) => { releases = r; }, onSignals: (s) => { store = s; },
    gates: { windowMs: 3_600_000 }, synthetic: async () => synthetic,
  })], config, { logger: quiet });
  reporter = createServiceClient({ caller: 'actions', http: { ...config.http, serviceUrls: { 'fleet-control': `http://127.0.0.1:${agent.port}` } } });
});

after(async () => {
  reporter?.close();
  await agent?.stop('test');
  await new Promise<void>((resolve) => (catalogueStub ? catalogueStub.close(() => resolve()) : resolve()));
  await fleet?.close();
  await kube?.close();
  await h?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the cell\'s Fleet agent applies the cell\'s releases (spec 11.1 to 11.3)', () => {
  let r1Rollout = '';

  test('a cell channel takes a release only once its configuration, flags and model routing are in fleet-control\'s store', async () => {
    const manifest = { ...manifestOf('r0x', []), flagsDigest: sha('flags never put') };
    await fleet.portal.call(registerRelease, { params: { releaseId: 'r0x' }, body: { manifest, operatorId: uuidv7() } });
    await assert.rejects(fleet.promote('r0x', 'dev'), { code: 'fleet.release_document_missing' });
  });

  test('a release: migrations as a Job holding a Secret the agent never reads, then its documents, then its images, one service and one zone at a time, fleet-control last', async () => {
    assert.equal(await releases.apply(uuidv7()), 'none', 'nothing released yet: the cell keeps what it runs');
    r1Rollout = await onDev('r1', ['Initial']);
    const since = kube.calls.length;
    assert.equal(await releases.apply(uuidv7()), 'applied');

    const [job] = [...kube.jobs.values()];
    const container = job!['spec'].template.spec.containers[0];
    assert.equal(container.image, `${REPO}/fleet-control@${sha('r1/fleet-control')}`, 'from the release\'s own image');
    assert.deepEqual(container.command, ['node', 'src/db/scripts/migrate.script.ts', 'cell']);
    assert.deepEqual(container.env[0], { name: 'CELL_MIGRATE_URL', valueFrom: { secretKeyRef: { name: 'silo-migrate', key: 'url' } } }, 'the URL is the Job\'s, never the agent\'s');
    assert.deepEqual(JSON.parse(container.env[1].value), [{ version: '0001', name: 'Initial', digest: sha('migration/Initial') }]);
    assert.equal(job!['spec'].template.spec.automountServiceAccountToken, false);

    const order = kube.calls.slice(since).filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.split('/').slice(-2).join('/')}`);
    const firstPatch = order.findIndex((o) => o.startsWith('PATCH deployments'));
    assert.ok(order.findIndex((o) => o.startsWith('POST jobs')) < firstPatch, 'the schema is expanded before any image moves');
    assert.deepEqual(patched(since), ['auth-a', 'auth-b', 'policy-a', 'fleet-control-a'], 'one zone first, fleet-control last');
    for (const [name, service] of [['auth-a', 'auth'], ['auth-b', 'auth'], ['policy-a', 'policy'], ['fleet-control-a', 'fleet-control']]) {
      assert.equal(kube.imageOf(name!), `${REPO}/${service}@${sha(`r1/${service}`)}`);
    }
    const configuration = kube.configMaps.get('silo-release-configuration')!;
    assert.deepEqual([Buffer.from(configuration['binaryData'].document, 'base64').toString(), configuration['metadata'].annotations['silo.io/digest']], ['config', sha('config')]);
    assert.deepEqual(Buffer.from(kube.configMaps.get('silo-release-flags')!['binaryData'].document, 'base64').toString(), 'flags');
    const now = await state();
    assert.deepEqual([now!.releaseId, now!.phase, now!.rolloutId], ['r1', 'applied', r1Rollout]);

    const { events } = await fleet.portal.call(listFleetEvents, { query: { cellId: 'test-1' } });
    assert.deepEqual(events.filter((e) => e.event === 'migration_applied').map((e) => e.releaseId), ['r1'], 'each migration reported applied');

    const again = kube.calls.length;
    assert.equal(await releases.apply(uuidv7()), 'unchanged');
    assert.equal(kube.calls.slice(again).filter((c) => c.method !== 'GET').length, 0, 'a release the cell runs is not applied again');
  });

  test('a release signed by another key is refused whole: nothing runs, nothing rolls', async () => {
    await fleet.fleetAgent.call(reportVerdict, { params: { rolloutId: r1Rollout, cellId: 'test-1' }, body: { releaseId: 'r1', gates: GATES.map((gate) => ({ gate, passed: true })) } });
    for (let i = 0; (await fleet.portal.call(readRollout, { params: { rolloutId: r1Rollout } })).status !== 'completed'; i++) {
      assert.ok(i < 200, 'the r1 rollout completes');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await onDev('r2', ['Initial', 'Second']);
    const forged = createCellReleases({
      services: fleet.fleetAgent, logger: quiet, kube: createKubernetesClient({ where: kube.url, namespace: 'silo' }),
      trusted: [trustedKey(generateKeyPairSync('ed25519').publicKey, 'release')],
      cell: { id: 'test-1', buildTarget: 'commercial', capabilities: new Set(['gcs', 'cloud_kms']) }, channel: 'dev',
      signals: createSignalStore(), gates: { ...DEFAULT_GATE_SETTINGS, windowMs: 0 },
      settings: { imageRepository: REPO, migrationSecret: 'silo-migrate', rollTimeoutMs: 5_000, checkEveryMs: 10 },
    });
    const since = kube.calls.length;
    await assert.rejects(forged.apply(uuidv7()), { code: 'fleet.signature_missing' });
    assert.equal(kube.calls.slice(since).filter((c) => c.method !== 'GET').length, 0);
  });

  test('a failed migration fails the release: nothing rolls, a failing verdict halts the rollout, and the cell stays on the release before', async () => {
    kube.jobOutcome = 'failed';
    const since = kube.calls.length;
    assert.equal(await releases.apply(uuidv7()), 'failed');
    assert.deepEqual(patched(since), [], 'no image moves on a schema that did not expand');
    const failed = await state();
    assert.deepEqual([failed!.releaseId, failed!.phase, failed!.failure, failed!.previousReleaseId], ['r2', 'failed', 'fleet.migration_failed', 'r1']);
    const rollout = await fleet.portal.call(readRollout, { params: { rolloutId: failed!.rolloutId! } });
    assert.equal(rollout.status, 'halted', 'the failing verdict halted the rollout');
    assert.equal(await releases.apply(uuidv7()), 'rolled_back', 'fleet-control names the release before');
    assert.equal(kube.calls.slice(since).filter((c) => c.method === 'POST' && c.path.endsWith('/jobs')).length, 1, 'going back runs no migration');
    assert.deepEqual([(await state())!.releaseId, (await state())!.phase], ['r1', 'applied']);
    kube.jobOutcome = 'succeeded';
  });

  test('a roll that stalls fails the release; going back rolls the images already moved back to the release before', async () => {
    kube.stall.add('policy-a');
    await onDev('r3', ['Initial', 'Second']);
    const since = kube.calls.length;
    assert.equal(await releases.apply(uuidv7()), 'failed');
    assert.deepEqual(patched(since), ['auth-a', 'auth-b', 'policy-a']);
    assert.equal(kube.imageOf('auth-a'), `${REPO}/auth@${sha('r3/auth')}`);
    assert.equal((await state())!.failure, 'fleet.roll_stalled');
    kube.stall.delete('policy-a');
    const back = kube.calls.length;
    assert.equal(await releases.apply(uuidv7()), 'rolled_back');
    assert.deepEqual(patched(back), ['auth-a', 'auth-b', 'policy-a']);
    for (const [name, service] of [['auth-a', 'auth'], ['policy-a', 'policy'], ['fleet-control-a', 'fleet-control']]) {
      assert.equal(kube.imageOf(name!), `${REPO}/${service}@${sha(`r1/${service}`)}`, `${name} back on r1`);
    }
  });
});

const signalsOf = (release: string, requests: { total: number; refused?: number; errors?: number; slow?: number }, gauges: Record<string, number> = {}): ProcessSignals => {
  const latency = new Array<number>(9).fill(0);
  latency[1] = requests.total - (requests.slow ?? 0);
  latency[8] = requests.slow ?? 0;
  return {
    services: ['actions'], release, startedAt: new Date(Date.now() - 60_000).toISOString(), reportedAt: new Date().toISOString(),
    requests: { total: requests.total, refused: requests.refused ?? 0, errors: requests.errors ?? 0, latency }, gauges,
  };
};
const report = (processId: string, signals: ProcessSignals) => reporter.call(reportProcessSignals, { params: { processId }, body: signals });
const verdictOf = async (rolloutId: string) => (await fleet.portal.call(readRollout, { params: { rolloutId } })).verdicts['test-1'];
/** The release the cell runs, as if applied two hours ago: past the gates' window. */
const aged = (): void => {
  const map = kube.configMaps.get('silo-fleet-state')!;
  map['data'].state = JSON.stringify({ ...JSON.parse(map['data'].state), at: new Date(Date.now() - 2 * 3_600_000).toISOString() });
};

describe('the catalogue\'s release (D200)', () => {
  test('a release carrying the catalogue\'s release: its document required to promote it, then installed by catalogue going forward', async () => {
    const signed = {
      release: { version: 'cat-1', connectors: [{ slug: 'acme-crm', name: 'Acme CRM', provider: 'Acme', document: { schemaVersion: '1' } }] },
      signature: 'A'.repeat(86), keyId: 'B'.repeat(43),
    };
    const bytes = Buffer.from(JSON.stringify(signed));
    const digest = sha(bytes);
    await fleet.portal.call(registerRelease, { params: { releaseId: 'rcat' }, body: { manifest: { ...manifestOf('rcat', ['Initial', 'Second']), catalogueDigest: digest }, operatorId: uuidv7() } });
    await assert.rejects(fleet.promote('rcat', 'dev'), { code: 'fleet.release_document_missing' }, 'not before its catalogue document is in the store');
    await putReleaseDocument(directoryArtefactStore(path.join(dir, 'artefacts')), bytes);
    const rolloutId = (await fleet.promote('rcat', 'dev')).rolloutId!;
    assert.equal(await releases.apply(uuidv7()), 'applied');
    assert.deepEqual(catalogueBodies.at(-1), signed, 'catalogue was handed the signed release exactly');
    await fleet.fleetAgent.call(reportVerdict, { params: { rolloutId, cellId: 'test-1' }, body: { releaseId: 'rcat', gates: GATES.map((gate) => ({ gate, passed: true })) } });
    for (let i = 0; (await fleet.portal.call(readRollout, { params: { rolloutId } })).status !== 'completed'; i++) {
      assert.ok(i < 200, 'the rollout completes');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
});

describe('health gates and verdicts (spec 11.2)', () => {
  test('every process reports what it answered under its release; the relay its backlog', async () => {
    const config = loadConfig({
      SILO_ENV: 'test', SILO_SERVICE: 'expression-evaluator', SILO_CELL_ID: 'test-1', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
      SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', SILO_RELEASE: 'r-process',
      SERVICE_URL_FLEET_CONTROL: `http://127.0.0.1:${agent.port}`,
    });
    const evaluator = await runProcess([expressionEvaluator], config, { logger: quiet, signalsReportMs: 50 });
    try {
      for (let i = 0; store.on('r-process', 60_000).length === 0; i++) {
        assert.ok(i < 100, 'the process reported');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const [got] = store.on('r-process', 60_000);
      assert.deepEqual([got!.services, got!.requests.latency.length], [['expression-evaluator'], 9]);
    } finally {
      await evaluator.stop('test');
    }
  });

  test('a release that has run its window is judged; passing needs every gate, the synthetic tests included', async () => {
    const rolloutId = await onDev('r4', ['Initial', 'Second']);
    assert.equal(await releases.apply(uuidv7()), 'applied');
    assert.equal(kube.deployments.get('auth-a')!['spec'].template.spec.containers[0].env[0].value, 'r4', 'SILO_RELEASE set with the image');
    assert.equal(await releases.judge(uuidv7()), 'not_due', 'judged only once it has run the window');
    aged();
    await report('auth-r1', signalsOf('r1', { total: 1_000, refused: 20 }));
    await report('auth-r4', signalsOf('r4', { total: 1_000, refused: 30, errors: 3 }));
    await report('relay-r4', signalsOf('r4', { total: 0 }, { audit_outbox_oldest_seconds: 4 }));
    synthetic = undefined;
    assert.equal(await releases.judge(uuidv7()), 'waiting', 'nothing passes before the synthetic tests have run');
    assert.equal(await verdictOf(rolloutId), undefined);
    synthetic = { synthetic_question: true, synthetic_subscription: true, synthetic_action: true, synthetic_revert: true };
    assert.equal(await releases.judge(uuidv7()), 'passed');
    assert.equal((await verdictOf(rolloutId))!.verdict, 'pass');
    for (let i = 0; (await fleet.portal.call(readRollout, { params: { rolloutId } })).status !== 'completed'; i++) {
      assert.ok(i < 200, 'a passing verdict completes the dev rollout');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });

  test('failing gates are reported at once: errors beyond 1%, refusals beyond twice the release before, a slow 95th percentile', async () => {
    const rolloutId = await onDev('r5', ['Initial', 'Second']);
    assert.equal(await releases.apply(uuidv7()), 'applied');
    aged();
    await report('auth-r5', signalsOf('r5', { total: 1_000, refused: 120, errors: 20, slow: 100 }));
    await report('relay-r5', signalsOf('r5', { total: 0 }, { audit_outbox_oldest_seconds: 4 }));
    assert.equal(await releases.judge(uuidv7()), 'failed');
    const verdict = await verdictOf(rolloutId);
    assert.deepEqual([verdict!.verdict, [...verdict!.failedGates].sort()], ['fail', ['error_rate', 'latency', 'refusal_rate']]);
    assert.equal((await fleet.portal.call(readRollout, { params: { rolloutId } })).status, 'halted');
    assert.equal(await releases.apply(uuidv7()), 'rolled_back');
  });

  test('crash loops and an audit backlog over five minutes fail it; so does a synthetic test', async () => {
    const rolloutId = await onDev('r6', ['Initial', 'Second']);
    assert.equal(await releases.apply(uuidv7()), 'applied');
    aged();
    kube.crash.add('policy-a');
    await report('auth-r6', signalsOf('r6', { total: 200 }));
    await report('relay-r6', signalsOf('r6', { total: 0 }, { audit_outbox_oldest_seconds: 900 }));
    synthetic = { synthetic_question: true, synthetic_subscription: true, synthetic_action: false, synthetic_revert: true };
    assert.equal(await releases.judge(uuidv7()), 'failed');
    assert.deepEqual([...(await verdictOf(rolloutId))!.failedGates].sort(), ['audit_outbox_backlog', 'crash_loops', 'synthetic_action']);
    kube.crash.delete('policy-a');
  });
});
