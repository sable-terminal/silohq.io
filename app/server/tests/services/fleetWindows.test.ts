// Change windows and freezes (spec 11.2 wave 5, 11.5), through a real fleet-control process on
// a fresh directory database: once stable's shared waves pass, a dedicated cell gets a rollout
// of its own, noticed in advance with the SBOM difference, held for the notice period and
// then to its customer's window; a freeze holds a security fix until the named change
// authority approves it; a failing verdict rolls back that cell alone.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { loadConfig } from '../../src/config/index.config.ts';
import { registerRelease, type ReleaseManifest } from '../../src/contracts/fleet-control/release.contract.ts';
import {
  approvePromotion, desiredRelease, GATES, putCellChangePolicy, readRollout, reportVerdict, requestPromotion, type RolloutView,
} from '../../src/contracts/fleet-control/rollout.contract.ts';
import { putReleaseSbom, readReleaseFindings, syncAdvisories } from '../../src/contracts/fleet-control/sbom.contract.ts';
import { listCellEvents, listFleetEvents, reportMigrationApplied, verifyFleetEvents } from '../../src/contracts/fleet-control/events.contract.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createFleetService } from '../../src/routes/fleet-control/index.route.ts';
import { directoryArtefactStore } from '../../src/services/fleet-control/artefactStore.service.ts';
import { putReleaseDocument } from '../../src/scripts/putReleaseDocument.script.ts';
import { inWindow } from '../../src/services/fleet-control/changeWindows.service.ts';
import { createHarness, uuidv7, type Harness } from '../db/harness.helper.ts';
import { zipOf } from '../utils/zipWriter.helper.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PASS = GATES.map((gate) => ({ gate, passed: true }));
const hex = (text: string): string => createHash('sha256').update(text).digest('hex');
const pem = (key: KeyObject): string => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const quiet = createLogger({ service: 'fleet-control', cell: 'global-uk', release: 'test', level: 'error', write: () => undefined });
const engineers = { a: uuidv7(), b: uuidv7() };
const customer = { organisationId: uuidv7(), authority: uuidv7(), someoneElse: uuidv7() };
const releaseKeys = generateKeyPairSync('ed25519');

let clock = Date.parse('2026-11-02T09:00:00Z');
let h: Harness;
let root: string;
let fleet: RunningProcess;
let portal: ServiceClient;
let agent: ServiceClient;

const cyclonedx = (purls: string[]) => JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: purls.map((purl) => ({ purl })) });
const docs = (auth: string[]) => ({
  'image:auth': cyclonedx(auth),
  'image:policy': JSON.stringify({ spdxVersion: 'SPDX-2.3', packages: [] }),
  'agent:linux_x86_64': cyclonedx([]),
});
const releases = {
  rB: docs(['pkg:npm/left-pad@1.2.0', 'pkg:npm/lodash@4.17.20']),
  rC: docs(['pkg:npm/left-pad@1.3.0', 'pkg:npm/express@4.19.2']),
};

const manifestOf = (releaseId: keyof typeof releases, securityFix: boolean): ReleaseManifest => ({
  schema: 'silo.release.v1', releaseId, target: 'commercial', cellTemplateVersion: '1.0.0',
  images: [
    { service: 'auth', digest: `sha256:${hex(`${releaseId}/auth`)}`, sbom: { format: 'cyclonedx', digest: `sha256:${hex(releases[releaseId]['image:auth'])}` } },
    { service: 'policy', digest: `sha256:${hex(`${releaseId}/policy`)}`, sbom: { format: 'spdx', digest: `sha256:${hex(releases[releaseId]['image:policy'])}` } },
  ],
  migrations: [{ database: 'cell', version: '0001', name: 'Initial', digest: `sha256:${hex('0001')}` }], configurationDigest: `sha256:${hex('c')}`, flagsDigest: `sha256:${hex('f')}`, modelRoutingDigest: `sha256:${hex('m')}`,
  agentBinaries: [{ platform: 'linux_x86_64', version: '1.0.0', digest: `sha256:${hex(`${releaseId}/agent`)}`,
    sbom: { format: 'cyclonedx', digest: `sha256:${hex(releases[releaseId]['agent:linux_x86_64'])}` } }],
  capabilities: ['gcs', 'cloud_kms'], securityFix, provenance: { sourceCommit: 'c'.repeat(40), builder: 'ci' }, builtAt: new Date(clock).toISOString(),
});

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
const desired = () => agent.call(desiredRelease, { params: { cellId: 'ded-acme' }, query: { channel: 'stable' } });
const verdict = (rolloutId: string, cellId: string, releaseId: string, gates = PASS) =>
  agent.call(reportVerdict, { params: { rolloutId, cellId }, body: { releaseId, gates } });
const promote = async (releaseId: string, channel: string) => {
  const promotionId = uuidv7();
  const requested = await portal.call(requestPromotion, { params: { promotionId }, body: { releaseId, channel: channel as never, requestedBy: engineers.a, expedite: false } });
  if (requested.state === 'applied') return requested;
  return portal.call(approvePromotion, { params: { promotionId }, body: { approvedBy: engineers.b } });
};

/** Through the test and canary cells, the two-wave way every channel past dev goes here. */
async function passTestAndCanary(rolloutId: string, releaseId: string): Promise<void> {
  await verdict(rolloutId, 'test-1', releaseId);
  clock += 4 * HOUR;
  await waitFor(() => rollout(rolloutId), (r: RolloutView) => r.waves[1]!.startedAt !== null);
  await verdict(rolloutId, 'uk-lon-canary', releaseId);
  clock += 48 * HOUR;
  await waitFor(() => rollout(rolloutId), (r: RolloutView) => r.status === 'completed');
}

/** A release from registration to stable's shared waves passed. */
async function toStable(releaseId: keyof typeof releases, securityFix: boolean): Promise<string> {
  await portal.call(registerRelease, { params: { releaseId }, body: { manifest: manifestOf(releaseId, securityFix), operatorId: engineers.a } });
  const dev = await promote(releaseId, 'dev');
  await verdict(dev.rolloutId!, 'test-1', releaseId);
  await waitFor(() => rollout(dev.rolloutId!), (r: RolloutView) => r.status === 'completed');
  await passTestAndCanary((await promote(releaseId, 'canary')).rolloutId!, releaseId);
  for (const document of Object.values(releases[releaseId])) {
    await portal.call(putReleaseSbom, { params: { releaseId, sha256: hex(document) }, body: { document, operatorId: engineers.a } });
  }
  const at = new Date(clock).toISOString();
  await portal.call(syncAdvisories, { body: { operatorId: engineers.a } });
  await waitFor(() => portal.call(readReleaseFindings, { params: { releaseId } }), (f) => f.feeds.every((x) => x.lastSyncedAt === at));
  const stable = await promote(releaseId, 'stable');
  await passTestAndCanary(stable.rolloutId!, releaseId);
  return stable.rolloutId!;
}

const policy = { timeZone: 'Europe/London', windows: [{ day: 6, start: '02:00', end: '06:00' }] };
const report = (extra: Partial<{ freezes: unknown[]; exceptions: unknown[] }> = {}) => agent.call(putCellChangePolicy, {
  params: { cellId: 'ded-acme' },
  body: {
    organisationId: customer.organisationId, ...policy, changeAuthorityMembershipId: customer.authority,
    freezes: [], exceptions: [], ...extra,
  } as never,
});
/** On to the next moment the window is open (or closed), an hour at a time. */
const until = (open: boolean): void => {
  while (inWindow({ ...policy }, clock) !== open) clock += HOUR;
};

before(async () => {
  h = await createHarness();
  const writer: pg.Client = await h.connect('test_dir_writer', 'directory');
  for (const [id, kind] of [['test-1', 'commercial'], ['uk-lon-canary', 'commercial'], ['ded-acme', 'dedicated']]) {
    await writer.query(`insert into directory.cells (id, kind, residency, hostname, status) values ($1, $2, 'uk', $3, 'active')`, [id, kind, `${id}.silohq.io`]);
  }
  root = await mkdtemp(path.join(tmpdir(), 'silo-fleet-windows-'));
  await mkdir(path.join(root, 'feed', 'npm'), { recursive: true });
  await writeFile(path.join(root, 'feed', 'npm', 'all.zip'), zipOf([]));
  await writeFile(path.join(root, 'feed', 'npm', 'modified_id.csv'), '');
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'fleet-control', SILO_CELL_ID: 'global-uk', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
    PG_DIRECTORY_URL: h.url('test_fleet', 'directory'), FLEET_TEST_CELLS: 'test-1', FLEET_CANARY_CELLS: 'uk-lon-canary',
    FLEET_ARTEFACT_DIR: path.join(root, 'artefacts'), FLEET_SIGNING_KEY: pem(releaseKeys.privateKey),
    FLEET_ADVISORY_URL: pathToFileURL(path.join(root, 'feed')).href,
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
  await h?.close();
  await rm(root, { recursive: true, force: true });
});

describe('a dedicated cell in its customer\'s window (spec 11.5)', () => {
  test('only a dedicated cell has a change policy', async () => {
    assert.deepEqual((await report()).freezesSet, 0);
    await assert.rejects(agent.call(putCellChangePolicy, {
      params: { cellId: 'test-1' },
      body: { organisationId: customer.organisationId, ...policy, changeAuthorityMembershipId: null, freezes: [], exceptions: [] },
    }), { code: 'fleet.change_policy_not_dedicated' });
  });

  test('stable\'s shared waves pass; the dedicated cell is told in advance, then waits for its window', async () => {
    const shared = await toStable('rB', false);
    assert.deepEqual((await rollout(shared)).waves.map((w) => w.cells), [['test-1'], ['uk-lon-canary']], 'no dedicated cell in the shared waves');
    const told = await waitFor(desired, (d) => d.notice !== null);
    assert.deepEqual([told.reason, told.releaseId, told.notice!.releaseId, told.notice!.hold], ['wave_pending', null, 'rB', 'notice']);
    assert.equal(Date.parse(told.notice!.earliestStartAt) - Date.parse(told.notice!.noticedAt), 72 * HOUR);
    assert.equal(told.notice!.sbomDifference.complete, false, 'nothing before it to compare with');
    assert.deepEqual(told.notice!.sbomDifference.added.map((a) => a.purl), ['pkg:npm/left-pad@1.2.0', 'pkg:npm/lodash@4.17.20']);

    clock += 73 * HOUR;
    until(false);
    const waiting = await desired();
    assert.deepEqual([waiting.reason, waiting.notice!.hold], ['wave_pending', 'window']);

    until(true);
    const started = await waitFor(desired, (d) => d.reason === 'wave_started');
    assert.deepEqual([started.releaseId, started.notice], ['rB', null]);
    await verdict(started.rolloutId!, 'ded-acme', 'rB');
    clock += DAY;
    const done = await waitFor(desired, (d) => d.reason === 'current');
    assert.equal(done.releaseId, 'rB');
  });

  test('in a freeze, a security fix waits for the change authority\'s approval; the notice shows the SBOM difference', async () => {
    const freeze = { id: uuidv7(), startsAt: new Date(clock).toISOString(), endsAt: new Date(clock + 60 * DAY).toISOString(), reason: 'quarter end' };
    assert.equal((await report({ freezes: [freeze] })).freezesSet, 1);
    await toStable('rC', true);
    const told = await waitFor(desired, (d) => d.notice?.releaseId === 'rC');
    assert.deepEqual([told.reason, told.releaseId, told.notice!.hold, told.notice!.previousReleaseId], ['wave_pending', 'rB', 'freeze', 'rB'],
      'the cell keeps what it runs; a security fix needs no notice period, but the freeze holds it');
    assert.equal(told.notice!.earliestStartAt, told.notice!.noticedAt);
    assert.deepEqual(told.notice!.sbomDifference, {
      complete: true,
      added: [{ subject: 'image:auth', purl: 'pkg:npm/express@4.19.2' }],
      removed: [{ subject: 'image:auth', purl: 'pkg:npm/lodash@4.17.20' }],
      changed: [{ subject: 'image:auth', package: 'pkg:npm/left-pad', from: '1.2.0', to: '1.3.0' }],
      truncated: false,
    });

    const approval = (approvedBy: string) => ({ releaseId: 'rC', freezeId: freeze.id, approvedBy, approvedAt: new Date(clock).toISOString(), statement: 'Approved: CVE fix' });
    await report({ freezes: [freeze], exceptions: [approval(customer.someoneElse)] });
    until(true);
    assert.equal((await desired()).notice!.hold, 'freeze', 'an approval from anyone but the named change authority does not count');

    await report({ freezes: [freeze], exceptions: [approval(customer.authority)] });
    const started = await waitFor(desired, (d) => d.reason === 'wave_started');
    assert.equal(started.releaseId, 'rC');

    // A failing gate rolls this cell back alone; stable's own rollout stands.
    const failed = await verdict(started.rolloutId!, 'ded-acme', 'rC', PASS.filter((g) => g.gate !== 'synthetic_action'));
    assert.deepEqual([failed.status, failed.haltReason, failed.cellId], ['halted', 'gate_failed', 'ded-acme']);
    const back = await desired();
    assert.deepEqual([back.reason, back.releaseId], ['rolled_back', 'rB']);
    clock += HOUR;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual([(await desired()).reason, (await desired()).releaseId], ['rolled_back', 'rB'], 'a release the cell was rolled back from is not offered again');
  });

  test('Fleet\'s own events are recorded in order, chained, append only; a cell\'s agent reads its own (spec 11.6)', async () => {
    const all = (await portal.call(listFleetEvents, { query: { limit: '1000' } })).events;
    const ofRelease = (releaseId: string) => all.filter((e) => e.releaseId === releaseId && e.cellId === null).map((e) => `${e.event}${e.channel ? `:${e.channel}` : ''}`);
    assert.deepEqual(ofRelease('rB'), [
      'release_built', 'release_signed', 'release_promoted:dev', 'rollout_started:dev', 'rollout_completed:dev',
      'release_promoted:canary', 'rollout_started:canary', 'rollout_completed:canary',
      'release_promoted:stable', 'rollout_started:stable', 'rollout_completed:stable',
    ]);
    const built = all.find((e) => e.event === 'release_built' && e.releaseId === 'rC')!;
    assert.deepEqual([built.operatorId, built.detail['security_fix'], built.detail['source_commit']], [engineers.a, true, 'c'.repeat(40)]);
    // The cell's own record also holds its creation, from the capacity check (D207); this reads its rollouts.
    const cell = all.filter((e) => e.cellId === 'ded-acme' && e.event !== 'cell_created').map((e) => `${e.event}:${e.releaseId ?? '-'}`);
    assert.ok(all.some((e) => e.cellId === 'ded-acme' && e.event === 'cell_created'));
    assert.deepEqual(cell, ['rollout_started:rB', 'rollout_completed:rB', 'change_freeze_set:-', 'rollout_started:rC', 'rollout_gate_failed:rC', 'rollout_rolled_back:rC']);
    const failed = all.find((e) => e.event === 'rollout_gate_failed')!;
    assert.deepEqual([failed.detail['reason'], failed.detail['cells'], failed.detail['gates']], ['gate_failed', 'ded-acme', 'synthetic_action']);

    // The cell's agent reads its own events, and only those, from where it last read.
    const mine = await agent.call(listCellEvents, { params: { cellId: 'ded-acme' }, query: {} });
    assert.deepEqual(mine.events.map((e) => e.event), ['cell_created', 'rollout_started', 'rollout_completed', 'change_freeze_set', 'rollout_started', 'rollout_gate_failed', 'rollout_rolled_back'],
      'its creation first (D207), then its rollouts');
    const after = await agent.call(listCellEvents, { params: { cellId: 'ded-acme' }, query: { after: String(mine.events[3]!.seq) } });
    assert.equal(after.events.length, 3);

    // A migration applied in the cell is recorded once; one the release does not name is refused.
    const migration = { name: 'Initial', digest: `sha256:${hex('0001')}`, appliedAt: new Date(clock).toISOString() };
    const at = { cellId: 'ded-acme', releaseId: 'rB', database: 'cell' as const, version: '0001' };
    assert.deepEqual(await agent.call(reportMigrationApplied, { params: at, body: migration }), { recorded: true });
    assert.deepEqual(await agent.call(reportMigrationApplied, { params: at, body: migration }), { recorded: false });
    await assert.rejects(agent.call(reportMigrationApplied, { params: { ...at, version: '0002' }, body: migration }), { code: 'fleet.migration_unknown' });
    const applied = (await agent.call(listCellEvents, { params: { cellId: 'ded-acme' }, query: { after: String(mine.events.at(-1)!.seq) } })).events;
    assert.deepEqual(applied.map((e) => [e.event, e.detail['version']]), [['migration_applied', '0001']]);

    const verified = await portal.call(verifyFleetEvents, {});
    assert.deepEqual([verified.intact, verified.brokenAt, verified.events], [true, null, all.length + 1]);

    // fleet-control's own login may only add; the owner altering one event breaks the chain there.
    const writer = await h.connect('test_fleet', 'directory');
    await assert.rejects(writer.query(`update fleet.events set detail = '{}' where seq = $1`, [failed.seq]), /permission denied/);
    await writer.end();
    const owner = await h.connect('test_dir_migrate', 'directory');
    await owner.query(`update fleet.events set detail = jsonb_set(detail, '{gates}', '"none"') where seq = $1`, [failed.seq]);
    await owner.end();
    const broken = await portal.call(verifyFleetEvents, {});
    assert.deepEqual([broken.intact, broken.brokenAt], [false, failed.seq]);
  });
});
