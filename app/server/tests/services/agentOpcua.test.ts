// OPC UA end to end (spec 20.3, 20.7): an industrial endpoint on an OPC UA connection, reached
// through its Silo Agent pool; the agent browses the manifest's root node on the customer's
// network (here, the test plant served by gopcua from agent/internal/opcuatest), reads each
// instance's values at the fields' browse paths, and the cell reads the fields from its rows.
// The endpoint rules too: the plugin the manifest speaks, the scheme, the current policies, and
// None only with the owner's recorded exception. Signed (Basic256Sha256 SignAndEncrypt, against a
// second plant that trusts only the certificates in its trust directory): the credential service
// makes the endpoint's application certificate, the owner pins the server's, the endpoint is
// untrusted until verified, active once the server trusts the certificate, and untrusted again
// when a read finds the server has stopped. Subscriptions: the agent holding the capture monitors
// each pump's fields, and the server's values arrive as deltas on bus-live, the first of each item
// the backfill. Discovery: an OPC UA browse reaches the organisation's endpoints in the scan's
// targets through the agent, structure only, and its finding promotes to a connector. Real
// processes: credential, policy, auth, connect-registry, change-stream, connect-runtime,
// approvals, ontology, discovery, the Go agent built from agent/ and the plant command beside it.

import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createAgentPool, issueAgentEnrolmentToken } from '../../src/contracts/connect-registry/agent.contract.ts';
import { createPrivateKey } from 'node:crypto';
import { decideAllowlistRequest, requestAllowlistEntry } from '../../src/contracts/actions/allowlist.contract.ts';
import { declareWritablePoint } from '../../src/contracts/connect-registry/writablePoint.contract.ts';
import { prepareWrites, writeRecords } from '../../src/contracts/connect-runtime/write.contract.ts';
import { resolvePhysicalTargets } from '../../src/contracts/connect-runtime/physical.contract.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { createGrantSigner } from '../../src/services/actions/grants.service.ts';
import { TEST_GRANT_KEYS } from './connect.helper.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { getScanRun, listFindings, requestScanAuthorisation, reviewFinding, setDiscoveryEnabled, startScan } from '../../src/contracts/discovery/discovery.contract.ts';
import { getManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createDiscoveryService } from '../../src/routes/discovery/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { inTx } from '../db/harness.helper.ts';
import { setChangeCapture } from '../../src/contracts/change-stream/capture.contract.ts';
import { sourceChange, type SourceChange } from '../../src/contracts/change-stream/delta.contract.ts';
import { getStreamStatus } from '../../src/contracts/change-stream/stream.contract.ts';
import { loadConfig } from '../../src/config/index.config.ts';
import { connectLiveBus, type LiveBus } from '../../src/infra/bus.infra.ts';
import { registerChangeInterest } from '../../src/infra/keyspaces.infra.ts';
import { connectRedis, type RedisStore } from '../../src/infra/redis.infra.ts';
import { createChangeStreamService } from '../../src/routes/change-stream/index.route.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { changeConnectionStatus, createConnection, getConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { createIndustrialEndpoint, listIndustrialEndpoints, verifyIndustrialEndpoint } from '../../src/contracts/connect-registry/industrial.contract.ts';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as evaluatorService } from '../../src/routes/expression-evaluator/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import type { AgentTunnels } from '../../src/services/connect-runtime/agentTunnels.service.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { testAgentCa, testEndpointTls } from './agent.helper.ts';
import { hasGo, run } from './agentSource.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

const AGENT_DIR = path.resolve(import.meta.dirname, '../../../../agent');
const HOSTNAME = `agent.${CELL_ID}.silohq.io`;
/** The test plant's namespace (agent/internal/opcuatest). */
const PLANT = 'urn:silo:test:plant';

const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
});

let cell: ConnectCell;
let root: Signed;
let admin: Signed;
let ops: Signed;
let approver: Signed;
let agentId = '';
let plantPort = 0;
let tunnels: AgentTunnels | undefined;
let agent: ChildProcess | undefined;
let plant: ChildProcess | undefined;
let plantUrl = '';
let securePlant: ChildProcess | undefined;
let secureUrl = '';
let trustDir = '';
let serverCertificate: X509Certificate;
let dir = '';
let poolId = '';
const logs: string[] = [];
const received: SourceChange[] = [];
let bus: LiveBus | undefined;
let state: RedisStore | undefined;

const manifest = (maxInstances = 100, stream = false, writes = false) => doc({
  schemaVersion: '1', identity: { name: 'Pump house', provider: 'Example plant', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'opc_ua' }, auth: { strategy: 'none' },
  objects: [{
    name: 'pumps', identifier: ['id'],
    fields: [
      { name: 'id', type: 'string', path: '$browseName' },
      { name: 'node', type: 'string', path: '$nodeId' },
      { name: 'celsius', type: 'number', path: 'Temperature' },
      { name: 'mode', type: 'string', path: 'Mode' },
      { name: 'rpm', type: 'integer', path: 'Motor/Speed' },
    ],
    source: { kind: 'opc_ua', root: `nsu=${PLANT};s=Pumps`, maxInstances },
    // Setpoints (47.1): the declaration alone; commands, the methods called; every OPC UA write is physical.
    ...(writes ? {
      writes: {
        update: {}, risk: 'physical', bounds: { maxRows: 10 },
        custom: [{ name: 'start', opcua: { method: 'Motor/Start' }, compensatedBy: 'stop' }, { name: 'stop', opcua: { method: 'Motor/Stop' }, compensatedBy: 'start' }],
      },
    } : {}),
  }],
  ...(stream ? { changeStream: { objects: [{ object: 'pumps', sources: [{ kind: 'opcua', samplingMs: 50, deadband: { type: 'absolute', value: 1 } }] }] } } : {}),
});

async function connection(maxInstances?: number, stream = false, writes = false): Promise<string> {
  const gateway = cell.client('gateway');
  const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
  const connector = await gateway.call(createConnector, { body: { slug: `opcua-${uuidv7().slice(-12)}`, name: 'Pumps', provider: 'Example plant', sourceRoute: 'visual' } }, keyed());
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest(maxInstances, stream, writes) } }, keyed());
  const created = await gateway.call(createConnection, {
    body: { connectorId: connector.id, name: 'Pumps', owningScopeId: cell.scopes['engineering']!, agentPoolId: poolId },
  }, keyed());
  return created.id;
}

async function activate(id: string): Promise<void> {
  const gateway = cell.client('gateway');
  let version = (await cell.migrate.query('select version from connect.connections where id = $1', [id])).rows[0].version as number;
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(id);
    version = (await gateway.call(changeConnectionStatus, { params: { connectionId: id }, body: { move, version } }, cell.as(root))).version;
  }
}

const endpoint = (connectionId: string, body: Record<string, unknown>) =>
  cell.client('gateway').call(createIndustrialEndpoint, { params: { connectionId }, body: body as never }, cell.as(root));

let plantlessConnection: string | undefined;

const readPumps = (connectionId: string) =>
  cell.client('executor').call(readObject, { body: { connectionId, reason: 'query', step: { object: 'pumps' } } }, cell.as(root));

before(async () => {
  if (!hasGo) return;
  dir = await mkdtemp(path.join(tmpdir(), 'silo-agent-opcua-'));
  const binary = path.join(dir, 'silo-agent');
  const plantBinary = path.join(dir, 'plant');
  const env = { ...process.env, CGO_ENABLED: '0' };
  execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/silo-agent'], { cwd: AGENT_DIR, env, stdio: 'pipe' });
  execFileSync('go', ['build', '-trimpath', '-o', plantBinary, './internal/opcuatest/plant'], { cwd: AGENT_DIR, env, stdio: 'pipe' });
  plantPort = await freePort();
  plantUrl = `opc.tcp://127.0.0.1:${plantPort}`;
  const ready = (child: ChildProcess) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the test plant did not start')), 20_000);
    child.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('ready')) { clearTimeout(timer); resolve(); } });
    child.stderr!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the test plant exited ${code}: ${logs.join('')}`)); });
  });
  plant = spawn(plantBinary, ['-port', String(plantPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await ready(plant);
  // The secured plant: Basic256Sha256 beside None, trusting only what is in its trust directory.
  trustDir = path.join(dir, 'trusted');
  await mkdir(trustDir);
  const securePort = await freePort();
  secureUrl = `opc.tcp://127.0.0.1:${securePort}`;
  const certFile = path.join(dir, 'server.pem');
  securePlant = spawn(plantBinary, ['-port', String(securePort), '-trust-dir', trustDir, '-cert-out', certFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  await ready(securePlant);
  serverCertificate = new X509Certificate(await readFile(certFile));
  const ca = await testAgentCa();
  const tls = await testEndpointTls(HOSTNAME);
  await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
  await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
  let port = 0;
  // connect-runtime and discovery call each other: discovery's address is fixed first.
  const discoveryPort = await freePort();
  // connect-registry calls connect-runtime (an endpoint's verification), and connect-runtime the
  // compiler and evaluator: each started before its caller, which learns addresses as it starts.
  const liveEnv = { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl };
  cell = await createConnectCell({
    early: [
      { definition: pushdownService, name: 'pushdown-compiler' },
      { definition: evaluatorService, name: 'expression-evaluator' },
      // connect-runtime reports captures to change-stream.
      { definition: createChangeStreamService({ tickMs: 150 }), name: 'change-stream', extra: liveEnv },
      {
        definition: createConnectRuntimeService({
          onAgentEndpoint: (p) => { port = p; }, onAgentTunnels: (t) => { tunnels = t; }, agentHeartbeatMs: 200, agentCaptureLeaseMs: 3_000, agentCaptureRetryMs: 300,
          agentScanReportMs: 200,
        }),
        name: 'connect-runtime',
        extra: {
          AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
          AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem, SERVICE_URL_DISCOVERY: `http://127.0.0.1:${discoveryPort}`,
        },
      },
    ],
  });
  await cell.start(approvalsService, 'approvals', 'test_app');
  await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app');
  await cell.start(ontologyService, 'ontology', 'test_app');
  await cell.start(createDiscoveryService({ sweep: false }), 'discovery', 'test_app', { HTTP_PORT: String(discoveryPort) });
  const busConfig = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'change-stream', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', PG_CONTROL_URL: cell.h.url('test_app'), REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, ...liveEnv,
  });
  bus = await connectLiveBus(busConfig.bus, 'test');
  bus.subscribe(sourceChange, 'chg.>', (delta) => {
    if (delta.organisationId === cell.org) received.push(delta);
  });
  await bus.flush();
  state = await connectRedis('state', busConfig.redis);
  root = await cell.signIn('root@acme.example');
  admin = await cell.member('adm@acme.example', 'Admin', 'engineering');
  ops = await cell.member('ops@acme.example', 'Physical operations');
  approver = await cell.member('appr@acme.example', 'Admin', 'engineering');
  const gateway = cell.client('gateway');
  await gateway.call(setDiscoveryEnabled, { body: { enabled: true } }, cell.as(root));
  poolId = (await gateway.call(createAgentPool, { body: { name: 'Pump house', environment: 'production' } }, cell.as(root))).id;
  const config = path.join(dir, 'agent.json');
  await writeFile(config, JSON.stringify({
    endpoint: `127.0.0.1:${port}`, serverName: HOSTNAME, endpointCaFile: path.join(dir, 'endpoint.pem'), stateDir: path.join(dir, 'state'),
    name: 'pump-house', healthListen: `127.0.0.1:${await freePort()}`, targets: ['127.0.0.1'],
  }));
  await chmod(config, 0o600);
  const { token } = await gateway.call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
  await run(binary, ['enrol', '-config', config, '-token', token]);
  agentId = ((await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select id from connect.agents where pool_id = $1', [poolId]))).rows[0] as { id: string }).id;
  agent = spawn(binary, ['run', '-config', config, '-heartbeat', '200ms'], { stdio: ['ignore', 'pipe', 'pipe'] });
  agent.stdout!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  agent.stderr!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  const deadline = Date.now() + 30_000;
  while ((tunnels?.connected(cell.org, poolId).filter((a) => a.healthy).length ?? 0) !== 1) {
    if (Date.now() > deadline) assert.fail(`the agent did not connect\n${logs.slice(-10).join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

after(async () => {
  agent?.kill('SIGTERM');
  plant?.kill('SIGTERM');
  securePlant?.kill('SIGTERM');
  await bus?.close();
  await state?.close();
  await cell?.close();
  if (dir !== '') await rm(dir, { recursive: true, force: true });
});

describe('OPC UA (spec 20.3, 20.7)', { skip: !hasGo && 'needs Go to build the agent and the test plant' }, () => {
  test('an endpoint serves the protocol its manifest speaks, by opc.tcp and a current policy; None only with the owner\'s exception', async () => {
    const id = await connection();
    await assert.rejects(endpoint(id, { plugin: 'mqtt', endpointUrl: 'tcp://127.0.0.1:1883', securityPolicy: 'plain' }), { code: 'industrial.plugin_mismatch' });
    await assert.rejects(endpoint(id, { plugin: 'opcua', endpointUrl: 'tcp://127.0.0.1:4840', securityPolicy: 'None' }), { code: 'industrial.url_scheme' });
    // Basic256 is deprecated by the OPC Foundation; a policy is named with its mode.
    for (const securityPolicy of ['Basic256 Sign', 'Basic256Sha256', 'none']) {
      await assert.rejects(endpoint(id, { plugin: 'opcua', endpointUrl: plantUrl, securityPolicy }), { code: 'industrial.policy_invalid' }, securityPolicy);
    }
    await assert.rejects(endpoint(id, { plugin: 'opcua', endpointUrl: plantUrl, securityPolicy: 'None' }), { code: 'industrial.policy_none_refused' });
    await assert.rejects(endpoint(id, { plugin: 'opcua', endpointUrl: plantUrl, securityPolicy: 'Basic256Sha256 Sign', insecureException: true }),
      { code: 'industrial.exception_unused' });
    const insecure = await endpoint(id, { plugin: 'opcua', endpointUrl: plantUrl, securityPolicy: 'None', insecureException: true });
    assert.equal(insecure.insecureExceptionBy, root.membershipId);
    const { rows } = await cell.migrate.query(
      `select payload->>'event' as event from platform.outbox where organisation_id = $1 and payload->>'event' in ('industrial_endpoint_created', 'opcua_insecure_exception_recorded')
       and payload->'resource'->>'id' = $2 order by seq`, [cell.org, id]);
    assert.deepEqual(rows.map((r) => r.event), ['industrial_endpoint_created', 'opcua_insecure_exception_recorded']);
  });

  test('a read: the root\'s child objects as records, each field a browse path read by the agent', async () => {
    const id = await connection();
    await endpoint(id, { plugin: 'opcua', endpointUrl: plantUrl, securityPolicy: 'None', insecureException: true });
    await activate(id);
    const out = await readPumps(id);
    assert.deepEqual([...out.rows].sort((a, b) => String(a['id']).localeCompare(String(b['id']))), [
      { id: 'Pump1', node: `nsu=${PLANT};s=Pump1`, celsius: 61.5, mode: 'auto', rpm: 1450 },
      { id: 'Pump2', node: `nsu=${PLANT};s=Pump2`, celsius: 71.5, mode: 'manual', rpm: 0 },
    ], logs.slice(-5).join(''));
  });

  test('more instances than the source declares are refused, never truncated', async () => {
    const few = await connection(1);
    await endpoint(few, { plugin: 'opcua', endpointUrl: plantUrl, securityPolicy: 'None', insecureException: true });
    await activate(few);
    await assert.rejects(readPumps(few), { code: 'opcua.too_many_instances' });
  });

  test('signed: the endpoint\'s own certificate, the server\'s pinned; untrusted until verified, active once the server trusts it, untrusted when it stops', async () => {
    const gateway = cell.client('gateway');
    const verify = (connectionId: string, endpointId: string) =>
      gateway.call(verifyIndustrialEndpoint, { params: { connectionId, endpointId } }, cell.as(root));
    const id = await connection();
    const signed = { plugin: 'opcua', endpointUrl: secureUrl, securityPolicy: 'Basic256Sha256 SignAndEncrypt' };
    await assert.rejects(endpoint(id, signed), { code: 'industrial.server_certificate_required' });
    await assert.rejects(endpoint(plantlessConnection ??= await connection(), { ...signed, securityPolicy: 'None', insecureException: true, serverCertificateThumbprint: 'ab'.repeat(20) }),
      { code: 'industrial.server_certificate_unused' });
    // The thumbprint as a server's configuration shows it: colons, upper case.
    const created = await endpoint(id, { ...signed, serverCertificateThumbprint: serverCertificate.fingerprint256 });
    assert.equal(created.status, 'untrusted');
    assert.equal(created.serverCertificateThumbprint, serverCertificate.fingerprint256.replaceAll(':', '').toLowerCase());
    const application = new X509Certificate(created.applicationCertificate!.pem);
    assert.equal(application.subjectAltName, `URI:urn:silohq.io:agent:opcua:${created.id}`);
    assert.equal(created.applicationCertificate!.thumbprint, application.fingerprint.replaceAll(':', '').toLowerCase());
    assert.ok(application.verify(application.publicKey), 'self-signed');
    // Not yet trusted on the server.
    const first = await verify(id, created.id);
    assert.deepEqual([first.outcome, first.endpoint.status], ['untrusted', 'untrusted'], logs.slice(-5).join(''));
    // The customer's step: the certificate into the server's trust list. Then verified, and read.
    await writeFile(path.join(trustDir, 'silo-agent.pem'), created.applicationCertificate!.pem);
    const second = await verify(id, created.id);
    assert.deepEqual([second.outcome, second.endpoint.status], ['trusted', 'active'], logs.slice(-5).join(''));
    assert.ok(second.endpoint.namespaceUris.includes(PLANT));
    assert.equal(second.presented?.sha256, serverCertificate.fingerprint256.replaceAll(':', '').toLowerCase());
    await activate(id);
    const out = await readPumps(id);
    assert.deepEqual(out.rows.map((r) => r['id']).sort(), ['Pump1', 'Pump2']);
    // The server stops trusting it: the read is refused and the endpoint is untrusted until verified again.
    await unlink(path.join(trustDir, 'silo-agent.pem'));
    await assert.rejects(readPumps(id), { code: 'industrial.endpoint_untrusted' });
    const listed = await gateway.call(listIndustrialEndpoints, { params: { connectionId: id } }, cell.as(root));
    assert.equal(listed.endpoints[0]!.status, 'untrusted');
    const { rows } = await cell.migrate.query(
      `select payload->>'event' as event, payload->'detail'->>'found_by' as found_by from platform.outbox where organisation_id = $1
       and payload->>'event' in ('industrial_endpoint_untrusted', 'industrial_endpoint_verified') and payload->'resource'->>'id' = $2 order by seq`, [cell.org, id]);
    assert.deepEqual(rows.map((r) => [r.event, r.found_by]), [
      ['industrial_endpoint_untrusted', 'verification'], ['industrial_endpoint_verified', null], ['industrial_endpoint_untrusted', 'read'],
    ]);
    // The key opened only in the credential service, each time in the ledger: the probes and the reads.
    const ledger = await cell.migrate.query(
      `select u.reason, count(*)::int as n from iam.credential_unwraps u join connect.connection_credentials c on c.id = u.connection_credential_id
       where c.connection_id = $1 and c.purpose = 'opcua_application_key' group by u.reason order by u.reason`, [id]);
    assert.deepEqual(ledger.rows.map((r) => r.reason), ['probe', 'query']);

    // A server presenting another certificate than the one pinned: nothing sent, the endpoint untrusted.
    const pinnedElsewhere = await connection();
    const wrong = await endpoint(pinnedElsewhere, { ...signed, serverCertificateThumbprint: '00'.repeat(32) });
    const mismatch = await verify(pinnedElsewhere, wrong.id);
    assert.deepEqual([mismatch.outcome, mismatch.endpoint.status], ['server_certificate_mismatch', 'untrusted']);
    assert.equal(mismatch.presented, undefined);
  });

  test('subscriptions: each pump\'s fields monitored by the agent holding the capture; the server\'s values arrive as deltas, live, never spooled', async () => {
    const gateway = cell.client('gateway');
    const id = await connection(undefined, true);
    await endpoint(id, { plugin: 'opcua', endpointUrl: plantUrl, securityPolicy: 'None', insecureException: true });
    await activate(id);
    await registerChangeInterest(state!, CELL_ID, cell.org, id, ['pumps']);
    await gateway.call(setChangeCapture, { params: { connectionId: id }, body: { slotName: `silo_${Date.now()}`, confirmed: true } }, cell.as(root));
    const deadline = Date.now() + 30_000;
    const status = async () => (await gateway.call(getStreamStatus, { params: { connectionId: id } }, cell.as(root))).objects[0];
    while ((await status())?.status !== 'live' || (await status())?.inUse !== 'opcua') {
      if (Date.now() > deadline) assert.fail(`the subscription did not start: ${JSON.stringify(await status())}\n${logs.slice(-8).join('')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const rpmOf = (pump: string) => received.filter((d) => d.connectionId === id && d.entityRef === pump && 'rpm' in (d.changed as Record<string, unknown>))
      .map((d) => (d.changed as Record<string, unknown>)['rpm']);
    const until = async (check: () => boolean, what: string) => {
      const end = Date.now() + 15_000;
      while (!check()) {
        if (Date.now() > end) assert.fail(`${what}: ${JSON.stringify(received.filter((d) => d.connectionId === id).slice(-4))}\n${logs.slice(-8).join('')}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    // Each item's first value is the backfill.
    await until(() => rpmOf('Pump1').includes(1450) && rpmOf('Pump2').includes(0), 'no backfill arrived');
    // The motor turns up on the server: published, and a delta with the server's time as source_at.
    const before = Date.now();
    plant!.kill('SIGUSR1');
    await until(() => rpmOf('Pump1').includes(1460), 'the change did not arrive');
    const delta = received.find((d) => d.connectionId === id && (d.changed as Record<string, unknown>)['rpm'] === 1460)!;
    assert.deepEqual([delta.source, delta.object, delta.operation], ['opcua', 'pumps', 'update']);
    assert.ok(Date.parse(delta.sourceAt!) >= before - 5_000, `source_at ${delta.sourceAt}`);
    const { rows } = await cell.migrate.query('select method, leased_by_agent_id from connect.cdc_slots where connection_id = $1', [id]);
    assert.deepEqual([rows[0].method, rows[0].leased_by_agent_id !== null], ['opcua', true]);
  });

  test('discovery: the organisation\'s OPC UA servers in the targets are browsed through the agent, structure only; a finding promotes to a connector', async () => {
    const gateway = cell.client('gateway');
    const keyedBy = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });
    const a = await gateway.call(requestScanAuthorisation, {
      body: { agentId, ranges: ['127.0.0.1'], methods: ['opcua_browse'], maxHosts: 5, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    }, keyedBy(admin));
    await gateway.call(decideApproval, { params: { chainId: a.approvalChainId }, body: { decision: 'approved', diffHash: a.documentHash } }, cell.as(approver));
    const started = await gateway.call(startScan, { params: { authorisationId: a.id } }, keyedBy(admin));
    const until = Date.now() + 60_000;
    let run = await gateway.call(getScanRun, { params: { runId: started.id } }, cell.as(admin));
    while (run.status === 'running') {
      if (Date.now() > until) assert.fail(`the scan did not end\n${logs.slice(-8).join('')}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      run = await gateway.call(getScanRun, { params: { runId: started.id } }, cell.as(admin));
    }
    assert.equal(run.status, 'completed', JSON.stringify(run.reasons));
    // The plant once (endpoints at one address are one server); the secured plant's endpoint is not active, so not reached.
    const probed = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select host, port, method, outcome from connect.discovery_probes where run_id = $1', [started.id]));
    assert.deepEqual(probed.rows, [{ host: '127.0.0.1', port: plantPort, method: 'opcua_browse', outcome: 'identified' }]);
    const { findings } = await gateway.call(listFindings, { query: { runId: started.id } }, cell.as(admin));
    assert.equal(findings.length, 1);
    const finding = findings[0]!;
    assert.equal(finding.proposedConnectorType, 'opc_ua');
    assert.deepEqual(finding.found.opcua?.types.map((t) => [t.name, t.root, t.instances, t.variables.map((v) => `${v.path}:${v.dataType}`).join()]), [
      ['Pumps', `nsu=${PLANT};s=Pumps`, 2, 'Mode:String,Motor/Speed:Int32,Temperature:Double'],
    ]);
    assert.deepEqual(finding.proposedObjectTypes.map((t) => [t.sourceObject, t.apiName, t.identifier.join(), t.rowCount]), [['Pumps', 'pump', 'id', 2]]);
    const everything = JSON.stringify(findings);
    for (const value of ['61.5', '71.5', '1450', '"auto"', '"manual"']) assert.ok(!everything.includes(value), `${value} left the server`);
    // Approved and promoted: a private OPC UA connector reading the Pumps folder through the agent.
    const reviewed = await gateway.call(reviewFinding, {
      params: { findingId: finding.id }, body: { decision: 'approve', promote: { owningScopeId: cell.scopes['engineering']!, proposeOntology: false } },
    }, keyedBy(admin));
    const connection = await gateway.call(getConnection, { params: { connectionId: reviewed.promotedConnectionId! } }, cell.as(root));
    assert.equal(connection.agentPoolId, poolId);
    const version = await gateway.call(getManifestVersion, { params: { connectorId: reviewed.promotedConnectorId!, versionId: connection.manifestId } }, cell.as(root));
    const document = version.document as { protocol: { kind: string }; objects: { name: string; source: { root: string }; fields: { path?: string }[] }[] };
    assert.deepEqual([document.protocol.kind, document.objects[0]!.name, document.objects[0]!.source.root], ['opc_ua', 'pumps', `nsu=${PLANT};s=Pumps`]);
    assert.deepEqual(document.objects[0]!.fields.map((f) => f.path), ['$browseName', '$nodeId', 'Mode', 'Motor/Speed', 'Temperature']);
  });

  test('setpoints: written by the agent on a signed grant, to nodes in its signed allow-list only, within range, step and interval (spec 47.1, 47.4, 47.5)', async () => {
    const gateway = cell.client('gateway');
    const id = await connection(undefined, false, true);
    await endpoint(id, { plugin: 'opcua', endpointUrl: plantUrl, securityPolicy: 'None', insecureException: true });
    await activate(id);
    // Writes earned (17.1): set directly here; the write class is tested on its own.
    await cell.migrate.query('update connect.connections set writes_enabled = true, max_physical_writes_per_minute = 10 where id = $1', [id]);
    const speed = (pump: string) => `nsu=${PLANT};s=${pump}.Motor.Speed`;
    await gateway.call(declareWritablePoint, {
      params: { connectionId: id }, body: { address: speed('Pump1'), valueCheck: { cel: 'true' }, settleSeconds: 0, testSafe: false },
    }, cell.as(root));
    const asked = await gateway.call(requestAllowlistEntry, {
      params: { connectionId: id },
      body: { nodeAddress: speed('Pump1'), kind: 'setpoint', dataType: 'Int32', minValue: '0', maxValue: '1800', maxStep: '200', minIntervalSeconds: 60, objectId: uuidv7() },
    }, cell.as(root));
    await gateway.call(decideAllowlistRequest, { params: { requestId: asked.id }, body: { decision: 'approve' } }, cell.as(ops));
    // The agent holds the signed list before anything is written.
    const delivered = Date.now() + 15_000;
    while ((await cell.migrate.query(
      `select 1 from platform.outbox where organisation_id = $1 and payload->>'event' = 'allowlist_delivered_to_agent' and payload->'detail'->>'connection_id' = $2`, [cell.org, id])).rowCount === 0) {
      if (Date.now() > delivered) assert.fail(`the list did not reach the agent\n${logs.slice(-6).join('')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const actions = cell.client('actions');
    const signer = createGrantSigner(createPrivateKey(TEST_GRANT_KEYS.privateKey));
    const write = async (pump: string, rpm: number, prior: number) => {
      const plan = { connectionId: id, object: 'pumps', operations: [{ key: uuidv7(), operation: 'update_partial' as const, identifier: pump, values: { rpm }, prior: { rpm: prior } }] };
      const prepared = await actions.call(prepareWrites, { body: plan }, cell.as(root));
      assert.equal(prepared.grantRequired, true, 'a physical write runs only on a grant');
      const grant = signer.sign({
        organisationId: cell.org, actionId: uuidv7(), actionKind: 'mutation', connectionId: id, object: 'pumps',
        statements: prepared.statements!, payloadSha256: prepared.payloadSha256!,
      });
      return (await actions.call(writeRecords, { body: { ...plan, grant } }, cell.as(root))).results[0]!;
    };
    const rpm = async (pump: string) => (await readPumps(id)).rows.find((r) => r['id'] === pump)?.['rpm'];
    const before = Number(await rpm('Pump1'));

    // Listed, in range, a step under 200: written, and read back.
    const applied = await write('Pump1', before + 50, before);
    assert.deepEqual([applied.outcome, applied.physical?.nodes.map((n) => [n.nodeAddress, n.status])], ['applied', [[speed('Pump1'), 'good']]], logs.slice(-4).join(''));
    assert.equal(await rpm('Pump1'), before + 50);
    // Inside the entry's interval: refused by the agent, nothing written.
    const tooSoon = await write('Pump1', before + 60, before + 50);
    assert.deepEqual([tooSoon.outcome, tooSoon.error?.code, tooSoon.physical?.reason], ['failed', 'actuation.refused_by_agent', 'interval']);
    // A node not in the signed list: refused, whatever the cell asks.
    const unlisted = await write('Pump2', 100, 0);
    assert.deepEqual([unlisted.outcome, unlisted.physical?.reason], ['failed', 'not_listed']);
    assert.equal(await rpm('Pump1'), before + 50);
    assert.equal(await rpm('Pump2'), 0);
  });

  test('commands: a method resolved and called by the agent on a signed grant, listed as a method, outside its interval (spec 47.1, 47.4)', async () => {
    const gateway = cell.client('gateway');
    const id = await connection(undefined, false, true);
    await endpoint(id, { plugin: 'opcua', endpointUrl: plantUrl, securityPolicy: 'None', insecureException: true });
    await activate(id);
    await cell.migrate.query('update connect.connections set writes_enabled = true, max_physical_writes_per_minute = 10 where id = $1', [id]);
    const actions = cell.client('actions');
    // The method's address, read through the agent as a variable's is: what the allow-list names.
    const resolved = await actions.call(resolvePhysicalTargets, {
      body: { connectionId: id, object: 'pumps', commands: [{ identifier: 'Pump2', customAction: 'start', inputs: {} }] },
    }, cell.as(root));
    const start = `nsu=${PLANT};s=Pump2.Motor.Start`;
    assert.deepEqual(resolved.commands.map((c) => c.nodeAddress), [start]);
    await gateway.call(declareWritablePoint, { params: { connectionId: id }, body: { address: start, valueCheck: { cel: 'true' }, settleSeconds: 0, testSafe: false } }, cell.as(root));
    const asked = await gateway.call(requestAllowlistEntry, {
      params: { connectionId: id }, body: { nodeAddress: start, kind: 'method', dataType: 'Boolean', minIntervalSeconds: 60, objectId: uuidv7() },
    }, cell.as(root));
    await gateway.call(decideAllowlistRequest, { params: { requestId: asked.id }, body: { decision: 'approve' } }, cell.as(ops));
    const delivered = Date.now() + 15_000;
    while ((await cell.migrate.query(
      `select 1 from platform.outbox where organisation_id = $1 and payload->>'event' = 'allowlist_delivered_to_agent' and payload->'detail'->>'connection_id' = $2`, [cell.org, id])).rowCount === 0) {
      if (Date.now() > delivered) assert.fail(`the list did not reach the agent\n${logs.slice(-6).join('')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const signer = createGrantSigner(createPrivateKey(TEST_GRANT_KEYS.privateKey));
    const call = async (pump: string, customAction: 'start' | 'stop') => {
      const plan = { connectionId: id, object: 'pumps', operations: [{ key: uuidv7(), operation: 'custom' as const, identifier: pump, customAction, values: {} }] };
      const prepared = await actions.call(prepareWrites, { body: plan }, cell.as(root));
      const grant = signer.sign({
        organisationId: cell.org, actionId: uuidv7(), actionKind: 'mutation', connectionId: id, object: 'pumps',
        statements: prepared.statements!, payloadSha256: prepared.payloadSha256!,
      });
      return (await actions.call(writeRecords, { body: { ...plan, grant } }, cell.as(root))).results[0]!;
    };
    // Listed: called, and acknowledged by the server's good status.
    const started = await call('Pump2', 'start');
    assert.deepEqual([started.outcome, started.physical?.nodes.map((n) => [n.nodeAddress, n.status])], ['applied', [[start, 'good']]], logs.slice(-4).join(''));
    // Inside the entry's interval: refused by the agent; and a method not in the signed list, whatever the cell asks.
    const tooSoon = await call('Pump2', 'start');
    assert.deepEqual([tooSoon.outcome, tooSoon.error?.code, tooSoon.physical?.reason], ['failed', 'actuation.refused_by_agent', 'interval']);
    const unlisted = await call('Pump2', 'stop');
    assert.deepEqual([unlisted.outcome, unlisted.physical?.reason], ['failed', 'not_listed']);
  });
});
