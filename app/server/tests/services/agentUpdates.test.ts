// Silo Agent updates through Fleet (spec 10.7, 11.1, 11.4), from the release registry to the
// agent's offer: a real fleet-control takes agent releases onto agent-stable only once their
// binaries are in its artefact store; the cell's Fleet agent pulls the channel, checks it and
// copies the binaries into the cell; connect-runtime checks everything again (a forged release
// and a damaged binary are refused), rolls the newest release through the cell's agents in
// waves gated on heartbeat and error rate, and offers agents (played over mutual TLS by this
// test) updates by their pool's policy, one at a time. A refused release halts the rollout and
// the agents it updated are told to go back; an agent more than three minor releases behind is
// outdated, and refused work 90 days on. The Go agent's side is tests/services/agentUpdate.test.ts.

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  approveAgentPoolUpdate, createAgentPool, issueAgentEnrolmentToken, listAgentPools, listAgentReleases, setAgentPoolUpdatePolicy,
} from '../../src/contracts/connect-registry/agent.contract.ts';
import { installAgentRelease } from '../../src/contracts/connect-runtime/agentRelease.contract.ts';
import type { AgentUpdateOffer } from '../../src/contracts/connect-runtime/agentEndpoint.contract.ts';
import { readAgentBinary } from '../../src/contracts/fleet-control/agentBinary.contract.ts';
import { readRelease, registerRelease } from '../../src/contracts/fleet-control/release.contract.ts';
import { readChannel } from '../../src/contracts/fleet-control/rollout.contract.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { createFleetService } from '../../src/routes/fleet-control/index.route.ts';
import type { AgentTunnels } from '../../src/services/connect-runtime/agentTunnels.service.ts';
import type { AgentUpdates } from '../../src/services/connect-runtime/agentUpdates.service.ts';
import { checkAgentRelease } from '../../src/services/fleet-control/agentRelease.service.ts';
import type { CellFleetAgent } from '../../src/services/fleet-control/cellAgent.service.ts';
import { keyFileSigner, signDocument, trustedKey } from '../../src/services/fleet-control/signing.service.ts';
import { canonicalJson } from '../../src/utils/canonicalJson.util.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { startFakeAgent, testAgentCa, testAgentKey, testEndpointTls, type FakeAgent } from './agent.helper.ts';
import { sha, startReleaseFleet, type ReleaseFleet } from './agentRelease.helper.ts';
import { createConnectCell, type ConnectCell, type Signed } from './connect.helper.ts';
import { createMemoryStore, type MemoryStore } from './memoryStore.helper.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BEAT_MS = 150;
const HOSTNAME = `agent.${CELL_ID}.silohq.io`;

// The cell's clock: real time plus what the test moves it on by.
let ahead = 0;
const cellNow = (): number => Date.now() + ahead;

let cell: ConnectCell;
let root: Signed;
let dir: string;
let fleet: ReleaseFleet;
let objects: MemoryStore;
let cellAgent: CellFleetAgent;
let updates: AgentUpdates;
let tunnels: AgentTunnels;
let port = 0;
let serverCert = '';

interface Identity { agentId: string; cert: string; key: string }
const started: FakeAgent[] = [];

function call(method: string, pathname: string, who: Identity | undefined, body?: unknown): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, path: pathname, method, servername: HOSTNAME, ca: serverCert, minVersion: 'TLSv1.3', ...(who ? { cert: who.cert, key: who.key } : {}),
      headers: text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(text);
  });
}

const offerFor = async (who: Identity): Promise<AgentUpdateOffer> => {
  const res = await call('GET', '/v1/update', who);
  assert.equal(res.status, 200, res.body.toString());
  return JSON.parse(res.body.toString()) as AgentUpdateOffer;
};

async function enrol(poolId: string, name: string, platform = 'linux_x86_64', version = '1.0.0'): Promise<Identity> {
  const { token } = await cell.client('gateway').call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
  const key = await testAgentKey();
  const text = JSON.stringify({ token, csr: key.csr, name, hostname: `${name}.local`, platform, version });
  const res = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: '/v1/enrol', method: 'POST', servername: HOSTNAME, ca: serverCert, minVersion: 'TLSv1.3',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
    }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(text);
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { agentId: res.body['agentId'] as string, cert: res.body['certificate'] as string, key: key.keyPem };
}

/** The agent's tunnel, heartbeating a version: a restart onto another is a new tunnel naming it. */
const live = new Map<string, FakeAgent>();
function connectAgent(who: Identity, version: string): FakeAgent {
  live.get(who.agentId)?.close();
  const agent = startFakeAgent({ port, serverCert, servername: HOSTNAME, beatMs: BEAT_MS, identity: who, version, activeCalls: 0 });
  live.set(who.agentId, agent);
  started.push(agent);
  return agent;
}

async function waitFor<T>(what: string, read: () => Promise<T> | T, check: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const agentRow = async (agentId: string) => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  `select version, previous_version, updating_to, version_state, version_outdated_at, last_heartbeat_at, status, work_done, work_failed
   from connect.agents where id = $1`, [agentId]))).rows[0] as {
  version: string; previous_version: string | null; updating_to: string | null; version_state: string; version_outdated_at: string | null;
  last_heartbeat_at: string | null; status: string; work_done: string; work_failed: string;
};
const events = async (name: string) => (await cell.migrate.query(
  `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by seq`, [cell.org, name]))
  .rows.map((r) => (r as { payload: { detail: Record<string, unknown> } }).payload);
const rollouts = async () => (await cell.migrate.query(
  'select version, status, wave, halt_reason from connect.agent_rollouts order by started_at desc, id desc')).rows as
  { version: string; status: string; wave: number; halt_reason: string | null }[];

/** The cell's clock moves on; the live agents' next heartbeats carry it into their rows. */
async function advance(ms: number): Promise<void> {
  ahead += ms;
  const at = cellNow();
  for (const [agentId] of live) {
    await waitFor('the heartbeat after the clock moved', () => agentRow(agentId), (r) => r.last_heartbeat_at !== null && Date.parse(String(r.last_heartbeat_at)) >= at - 1_000);
  }
}

// ----------------------------------------------------------------------------- fleet-control

const binaries = new Map<string, Buffer>();
const bytesFor = (version: string, platform: string): Buffer => {
  const key = `${version}/${platform}`;
  if (!binaries.has(key)) binaries.set(key, Buffer.concat([Buffer.from(`silo-agent ${key}\n`), Buffer.alloc(5 * 1024 * 1024 + 17, version.length)]));
  return binaries.get(key)!;
};
const builds = (version: string, platforms: readonly string[] = ['linux_x86_64', 'linux_arm64']): Record<string, Buffer> =>
  Object.fromEntries(platforms.map((p) => [p, bytesFor(version, p)]));
const releaseAgent = (releaseId: string, version: string, options: { platforms?: string[]; holdBinaries?: boolean } = {}) =>
  fleet.release(releaseId, version, builds(version, options.platforms), options);
const promote = (releaseId: string, channel: string) => fleet.promote(releaseId, channel);

before(async () => {
  cell = await createConnectCell();
  root = await cell.signIn('root@acme.example');
  dir = await mkdtemp(path.join(tmpdir(), 'silo-agent-updates-'));
  fleet = await startReleaseFleet(cell.h, dir);

  // The cell: connect-runtime with the agent endpoint and the release key; Silo's own organisation is acme.
  objects = createMemoryStore();
  const ca = await testAgentCa();
  const tls = await testEndpointTls(HOSTNAME);
  serverCert = tls.cert;
  await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
  await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
  const storage = { OBJECT_STORE: 's3', OBJECT_BUCKET_FILES: 'silo-test-files', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true' };
  await cell.start(createConnectRuntimeService({
    onAgentEndpoint: (p) => { port = p; }, onAgentTunnels: (t) => { tunnels = t; }, onAgentUpdates: (u) => { updates = u; },
    agentHeartbeatMs: BEAT_MS, objects, now: cellNow, agentRolloutTickMs: 3_600_000,
  }), 'connect-runtime', 'test_app', {
    AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
    AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem,
    FLEET_RELEASE_PUBLIC_KEY_FILE: fleet.releasePublicFile, CONNECT_AGENT_FIRST_ORGANISATIONS: cell.org, ...storage,
  });
  // The cell's Fleet agent, under fleet-control's name, calling the global one.
  await cell.start(createFleetService({ objects, onCellAgent: (a) => { cellAgent = a; } }), 'fleet-control', 'test_app', {
    FLEET_ROLE: 'cell_agent', FLEET_RELEASE_PUBLIC_KEY_FILE: fleet.releasePublicFile, FLEET_AGENT_POLL_MINUTES: '600',
    SERVICE_URL_FLEET_CONTROL: `http://127.0.0.1:${fleet.port}`, ...storage,
  });
});

after(async () => {
  for (const agent of started) agent.close();
  await fleet?.close();
  await cell?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('agent releases reach the cell (spec 10.7, 11.1)', () => {
  test('agent-stable takes a release only once its binaries are in fleet-control\'s store', async () => {
    await releaseAgent('r110', '1.1.0', { holdBinaries: true });
    await assert.rejects(promote('r110', 'agent-stable'), { code: 'fleet.agent_binary_missing' });
    // A binary under another digest does not count.
    await fleet.putBinary(Buffer.from('something else'));
    await assert.rejects(promote('r110', 'agent-stable'), { code: 'fleet.agent_binary_missing' });
    for (const platform of ['linux_x86_64', 'linux_arm64']) await fleet.putBinary(bytesFor('1.1.0', platform));
    assert.equal((await promote('r110', 'agent-stable')).state, 'applied');
    const hex = sha(bytesFor('1.1.0', 'linux_arm64')).slice(7);
    const part = await fleet.fleetAgent.call(readAgentBinary, { params: { sha256: hex }, query: { offset: 4 * 1024 * 1024 } });
    assert.deepEqual([part.bytes, part.offset], [bytesFor('1.1.0', 'linux_arm64').length, 4 * 1024 * 1024]);
    assert.ok(Buffer.from(part.data, 'base64').equals(bytesFor('1.1.0', 'linux_arm64').subarray(4 * 1024 * 1024)));
    await assert.rejects(fleet.fleetAgent.call(readAgentBinary, { params: { sha256: 'f'.repeat(64) }, query: { offset: 0 } }), { code: 'fleet.agent_binary_unknown' });
  });

  test('the cell\'s Fleet agent carries it in: checked, copied by digest, installed once', async () => {
    assert.equal(await cellAgent.pull(uuidv7()), 'installed');
    assert.equal(await cellAgent.pull(uuidv7()), 'unchanged');
    for (const platform of ['linux_x86_64', 'linux_arm64']) {
      const body = objects.objects.get(`files:agent-binaries/${sha(bytesFor('1.1.0', platform)).slice(7)}`)?.body;
      assert.ok(body?.equals(bytesFor('1.1.0', platform)), `${platform} copied whole`);
    }
    const { rows } = await cell.migrate.query('select release_id, version, channel, binaries from connect.agent_releases');
    assert.deepEqual(rows.map((r) => [r.release_id, r.version, r.channel]), [['r110', '1.1.0', 'agent-stable']]);
    assert.deepEqual((rows[0].binaries as { platform: string; bytes: number }[]).map((b) => [b.platform, b.bytes]).sort(),
      [['linux_arm64', bytesFor('1.1.0', 'linux_arm64').length], ['linux_x86_64', bytesFor('1.1.0', 'linux_x86_64').length]]);
  });

  test('connect-runtime refuses a release not signed by the release key, not promoted, or with a damaged binary', async () => {
    const { head } = await fleet.fleetAgent.call(readChannel, { params: { channel: 'agent-stable' } });
    const release = await fleet.fleetAgent.call(readRelease, { params: { releaseId: 'r110' } });
    const signed = {
      head: { text: canonicalJson(head!.document), signatures: head!.signatures },
      release: { text: canonicalJson(release.manifest), signatures: release.signatures },
    };
    const install = (body: typeof signed) => cell.client('fleet-control').call(installAgentRelease, { body });
    assert.equal((await install(signed)).installed, false, 'installed already');

    // A cell compromised enough to sign its own: another key.
    const forger = generateKeyPairSync('ed25519');
    const forged = fleet.manifestOf('r-forged', '9.9.9', builds('9.9.9', ['linux_x86_64']));
    const signer = keyFileSigner(forger.privateKey, 'release', forger.publicKey);
    const forgedHead = { ...head!.document, releaseId: 'r-forged', manifestDigest: sha(canonicalJson(forged)), sequence: 99 };
    await assert.rejects(install({
      head: { text: canonicalJson(forgedHead), signatures: [await signDocument(signer, 'channel', forgedHead)] },
      release: { text: canonicalJson(forged), signatures: [await signDocument(signer, 'release', forged)] },
    }), { code: 'fleet.signature_missing' });
    // Text that is not what was signed, or not canonical.
    await assert.rejects(install({ ...signed, release: { ...signed.release, text: signed.release.text.replace('1.1.0', '1.1.1') } }), { code: 'fleet.signature_invalid' });
    await assert.rejects(install({ ...signed, release: { ...signed.release, text: JSON.stringify(release.manifest, null, 1) } }), { code: 'fleet.agent_release_refused' });
    // A release registered but never promoted: the head names another.
    await fleet.portal.call(registerRelease, { params: { releaseId: 'r-unpromoted' }, body: { manifest: fleet.manifestOf('r-unpromoted', '1.1.5', builds('1.1.5', ['linux_x86_64'])), operatorId: uuidv7() } });
    const unpromoted = await fleet.fleetAgent.call(readRelease, { params: { releaseId: 'r-unpromoted' } });
    await assert.rejects(install({ head: signed.head, release: { text: canonicalJson(unpromoted.manifest), signatures: unpromoted.signatures } }),
      (error: { code?: string; details?: { reason?: string } }) => error.code === 'fleet.agent_release_refused' && error.details?.reason === 'not_promoted');
  });
});

describe('waves, pools and offers (spec 10.7, 11.4)', () => {
  let poolA: string;
  let pinned: string;
  let approval: string;
  let a1: Identity;
  let a2: Identity;
  let arm: Identity;
  let p1: Identity;
  let q1: Identity;

  test('agents enrol on 1.0.0; the newest release starts its rollout at wave 0', async () => {
    const pool = (name: string) => cell.client('gateway').call(createAgentPool, { body: { name, environment: 'production' } }, cell.as(root));
    poolA = (await pool('Plant A')).id;
    pinned = (await pool('Plant P')).id;
    approval = (await pool('Plant Q')).id;
    a1 = await enrol(poolA, 'a1');
    a2 = await enrol(poolA, 'a2');
    arm = await enrol(pinned, 'arm', 'linux_arm64');
    p1 = await enrol(pinned, 'p1');
    q1 = await enrol(approval, 'q1');
    for (const who of [a1, a2, arm, p1, q1]) connectAgent(who, '1.0.0');
    await updates.tick();
    assert.deepEqual((await rollouts()).map((r) => [r.version, r.status, r.wave]), [['1.1.0', 'running', 0]]);
  });

  test('an automatic pool\'s agents update one at a time; the offer is what the agent itself would accept', async () => {
    const offer = await offerFor(a1);
    assert.equal(offer.action, 'update');
    if (offer.action !== 'update') return;
    assert.deepEqual([offer.version, offer.platform, offer.digest, offer.bytes], ['1.1.0', 'linux_x86_64', sha(bytesFor('1.1.0', 'linux_x86_64')), bytesFor('1.1.0', 'linux_x86_64').length]);
    const checked = checkAgentRelease({ head: offer.head, release: offer.release } as never, [trustedKey(fleet.releaseKeys.publicKey, 'release')], { channel: 'agent-stable', target: 'commercial' });
    assert.equal(checked.manifest.releaseId, 'r110');
    assert.equal((await offerFor(a2)).action, 'none', 'a1 is updating');
    assert.equal((await offerFor(a1)).action, 'update', 'asked again, the same offer');
    assert.equal((await agentRow(a1.agentId)).updating_to, '1.1.0');

    const download = await call('GET', `/v1/update/binary/${offer.digest.slice(7)}`, a1);
    assert.equal(download.status, 200);
    assert.ok(download.body.equals(bytesFor('1.1.0', 'linux_x86_64')), 'the binary, whole');
    assert.equal((await call('GET', `/v1/update/binary/${offer.digest.slice(7)}`, arm)).status, 404, 'another platform\'s binary is not this agent\'s');
    assert.equal((await call('GET', `/v1/update/binary/${'e'.repeat(64)}`, a1)).status, 404);
    assert.equal((await call('GET', '/v1/update', undefined)).status, 401, 'a certificate is needed');
  });

  test('the agent comes back on 1.1.0: agent_updated, and the pool\'s next agent is offered it', async () => {
    connectAgent(a1, '1.1.0');
    const row = await waitFor('a1 on 1.1.0', () => agentRow(a1.agentId), (r) => r.version === '1.1.0');
    assert.deepEqual([row.previous_version, row.updating_to], ['1.0.0', null]);
    const [updated] = await events('agent_updated');
    assert.deepEqual([updated!.detail['from_version'], updated!.detail['to_version'], updated!.detail['direction']], ['1.0.0', '1.1.0', 'up']);
    assert.equal((await offerFor(a2)).action, 'update');
    connectAgent(a2, '1.1.0');
    await waitFor('a2 on 1.1.0', () => agentRow(a2.agentId), (r) => r.version === '1.1.0' && r.updating_to === null);
  });

  test('a pinned pool takes its version, an approval pool only what was approved; versions must be known and not behind', async () => {
    const gateway = cell.client('gateway');
    await assert.rejects(gateway.call(setAgentPoolUpdatePolicy, { params: { poolId: pinned }, body: { policy: 'pinned', version: '1.4.0' } }, cell.as(root)),
      { code: 'agent.version_unknown' });
    await gateway.call(setAgentPoolUpdatePolicy, { params: { poolId: pinned }, body: { policy: 'pinned', version: '1.1.0' } }, cell.as(root));
    const armOffer = await offerFor(arm);
    assert.deepEqual([armOffer.action, armOffer.action === 'update' ? armOffer.platform : ''], ['update', 'linux_arm64']);

    assert.equal((await offerFor(q1)).action, 'update', 'automatic still: it follows the wave');
    await gateway.call(setAgentPoolUpdatePolicy, { params: { poolId: approval }, body: { policy: 'approval' } }, cell.as(root));
    assert.equal((await offerFor(q1)).action, 'none', 'nothing approved yet');
    await gateway.call(approveAgentPoolUpdate, { params: { poolId: approval }, body: { version: '1.1.0' } }, cell.as(root));
    assert.equal((await offerFor(q1)).action, 'update');
    const pools = await gateway.call(listAgentPools, {}, cell.as(root));
    assert.equal(pools.pools.find((p) => p.id === approval)!.approvedVersion, '1.1.0');
    assert.deepEqual((await events('agent_update_policy_set')).map((e) => e.detail['policy']), ['pinned', 'approval']);
    assert.equal((await events('agent_update_approved')).length, 1);
  });

  test('wave 0 soaks; empty waves pass at once; the rollout completes', async () => {
    await updates.tick();
    assert.equal((await rollouts())[0]!.wave, 0, 'wave 0 soaks 24 hours');
    await advance(25 * HOUR);
    await updates.tick();
    assert.deepEqual((await rollouts()).map((r) => [r.version, r.status]), [['1.1.0', 'completed']], 'waves 1 to 3 hold no agents here');
  });

  test('an agent refusing a release halts its rollout, and the agents it updated go back', async () => {
    await releaseAgent('r120', '1.2.0');
    assert.equal(await cellAgent.pull(uuidv7()), 'installed');
    await updates.tick();
    assert.deepEqual((await rollouts())[0], { version: '1.2.0', status: 'running', wave: 0, halt_reason: null });
    // a1 takes 1.2.0 and comes back on it; a2, offered it next, refuses it.
    assert.equal((await offerFor(a1)).action, 'update');
    connectAgent(a1, '1.2.0');
    await waitFor('a1 on 1.2.0', () => agentRow(a1.agentId), (r) => r.version === '1.2.0');
    assert.equal((await offerFor(a2)).action, 'update');
    const reported = await call('POST', '/v1/update/report', a2, { version: '1.2.0', outcome: 'refused', reason: 'signature' });
    assert.equal(reported.status, 200);
    assert.deepEqual((await rollouts())[0], { version: '1.2.0', status: 'halted', wave: 0, halt_reason: 'refused' });
    const [refused] = await events('agent_update_refused');
    assert.deepEqual([refused!.detail['version'], refused!.detail['reason']], ['1.2.0', 'signature']);
    assert.equal((await agentRow(a2.agentId)).updating_to, null);
    assert.deepEqual(await offerFor(a1), { action: 'rollback', version: '1.1.0' });
    assert.equal((await offerFor(a2)).action, 'none', 'a halted release is offered to no one');
    connectAgent(a1, '1.1.0');
    await waitFor('a1 back on 1.1.0', () => agentRow(a1.agentId), (r) => r.version === '1.1.0');
    assert.equal((await events('agent_updated')).at(-1)!.detail['direction'], 'down');
    assert.equal((await offerFor(a1)).action, 'none');
  });

  test('an agent that took a release and did not come back halts the rollout on its heartbeat', async () => {
    await releaseAgent('r130', '1.3.0');
    assert.equal(await cellAgent.pull(uuidv7()), 'installed');
    await updates.tick();
    assert.equal((await offerFor(a1)).action, 'update');
    live.get(a1.agentId)!.close();
    live.delete(a1.agentId);
    await advance(20 * 60_000);
    await updates.tick();
    assert.equal((await rollouts())[0]!.status, 'running', 'within its 30 minutes');
    await advance(11 * 60_000);
    await updates.tick();
    assert.deepEqual((await rollouts())[0], { version: '1.3.0', status: 'halted', wave: 0, halt_reason: 'heartbeat' });
  });

  test('an updated agent failing its work halts the rollout on the error rate', async () => {
    await releaseAgent('r140', '1.4.0', { platforms: ['linux_x86_64'] });
    assert.equal(await cellAgent.pull(uuidv7()), 'installed');
    await updates.tick();
    assert.equal((await offerFor(a2)).action, 'update');
    connectAgent(a2, '1.4.0');
    await waitFor('a2 on 1.4.0', () => agentRow(a2.agentId), (r) => r.version === '1.4.0');
    // Work through the tunnel: the agent fails what it is given itself.
    const agent = live.get(a2.agentId)!;
    agent.answer = () => [{ type: 'error', category: 'internal' }];
    await waitFor('a2\'s new tunnel healthy', () => tunnels.connected(cell.org, poolA), (agents) => agents.some((a) => a.agentId === a2.agentId && a.healthy));
    for (let i = 0; i < 25; i++) {
      const frames = [];
      for await (const frame of tunnels.dispatch({ organisationId: cell.org, poolId: poolA, agentId: a2.agentId, kind: 'ping', payload: {}, timeoutMs: 3_000 })) frames.push(frame);
    }
    await advance(2 * 60_000);
    const row = await waitFor('the work counted', () => agentRow(a2.agentId), (r) => Number(r.work_done) >= 25);
    assert.equal(Number(row.work_failed), Number(row.work_done));
    await updates.tick();
    assert.deepEqual((await rollouts())[0], { version: '1.4.0', status: 'halted', wave: 0, halt_reason: 'error_rate' });
  });

  test('an agent older than the last three minor releases is outdated, and refused work after 90 days', async () => {
    // Received: 1.1, 1.2, 1.3 and 1.4: the floor is 1.2.
    await updates.tick();
    const listed = await cell.client('gateway').call(listAgentReleases, {}, cell.as(root));
    assert.equal(listed.outdatedBelow, '1.2.0');
    assert.deepEqual(listed.releases.map((r) => r.version), ['1.4.0', '1.3.0', '1.2.0', '1.1.0']);
    assert.deepEqual([listed.rollout?.version, listed.rollout?.status, listed.rollout?.haltReason], ['1.4.0', 'halted', 'error_rate']);
    const row = await agentRow(p1.agentId);
    assert.equal(row.version_state, 'outdated', 'p1 still on 1.0.0');
    assert.equal((await agentRow(a1.agentId)).version_state, 'outdated', 'a1 on 1.1.0');
    assert.equal((await agentRow(a2.agentId)).version_state, 'current');
    await advance(91 * DAY);
    await updates.tick();
    assert.equal((await agentRow(p1.agentId)).version_state, 'refused');
    // Refused work: p1 is the pinned pool's only x86 agent.
    await waitFor('the refusal reaches the tunnel', () => agentRow(p1.agentId), (r) => r.version_state === 'refused');
    await assert.rejects(async () => {
      for await (const _ of tunnels.dispatch({ organisationId: cell.org, poolId: pinned, agentId: p1.agentId, kind: 'ping', payload: {}, timeoutMs: 3_000 })) { /* none */ }
    }, (error: { code?: string }) => error.code === 'agent.not_here' || error.code === 'agent.version_refused');
    // It may still update: the pin is 1.1.0, newer than what it runs.
    assert.equal((await offerFor(p1)).action, 'update');
    connectAgent(p1, '1.1.0');
    await waitFor('p1 on 1.1.0', () => agentRow(p1.agentId), (r) => r.version === '1.1.0');
    await updates.tick();
    assert.equal((await agentRow(p1.agentId)).version_state, 'outdated', '1.1 is still below the floor, and outdated afresh');
  });
});
