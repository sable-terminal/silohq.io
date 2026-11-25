// MQTT end to end (spec 20.1, 20.2, 20.6, 20.7): an industrial endpoint on a connection reached
// through its Silo Agent pool; the agent subscribes on the customer's network (here, the test
// environment's NATS with its MQTT listener) and returns the broker's retained messages, which
// the cell decodes with the manifest's JSONata. The industrial endpoint rules too: the plugin
// the manifest speaks, and the scheme and policy MQTT takes (OPC UA's in agentOpcua.test).
// Telemetry: the agent holding the capture subscribes and sends messages
// up as they arrive, never spooled, and change-stream publishes them on bus-live. Commands
// (47.1): published by the agent on a signed grant, to topics in its signed allow-list only.
// Real processes: credential, policy, auth, connect-registry, change-stream, connect-runtime,
// approvals, actions, and the Go agent built from agent/.

import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { connect as tcp, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config/index.config.ts';
import { setChangeCapture } from '../../src/contracts/change-stream/capture.contract.ts';
import { sourceChange, type SourceChange } from '../../src/contracts/change-stream/delta.contract.ts';
import { getStreamStatus } from '../../src/contracts/change-stream/stream.contract.ts';
import { createAgentPool, issueAgentEnrolmentToken } from '../../src/contracts/connect-registry/agent.contract.ts';
import { connectLiveBus, type LiveBus } from '../../src/infra/bus.infra.ts';
import { registerChangeInterest } from '../../src/infra/keyspaces.infra.ts';
import { connectRedis, type RedisStore } from '../../src/infra/redis.infra.ts';
import { createChangeStreamService } from '../../src/routes/change-stream/index.route.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { changeConnectionStatus, createConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { createIndustrialEndpoint, listIndustrialEndpoints } from '../../src/contracts/connect-registry/industrial.contract.ts';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { prepareWrites, writeRecords } from '../../src/contracts/connect-runtime/write.contract.ts';
import { decideAllowlistRequest, requestAllowlistEntry } from '../../src/contracts/actions/allowlist.contract.ts';
import { declareWritablePoint } from '../../src/contracts/connect-registry/writablePoint.contract.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createGrantSigner } from '../../src/services/actions/grants.service.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as evaluatorService } from '../../src/routes/expression-evaluator/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import type { AgentTunnels } from '../../src/services/connect-runtime/agentTunnels.service.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { testAgentCa, testEndpointTls } from './agent.helper.ts';
import { hasGo, reachable, run } from './agentSource.helper.ts';
import { createConnectCell, doc, TEST_GRANT_KEYS, type ConnectCell, type Signed } from './connect.helper.ts';

const AGENT_DIR = path.resolve(import.meta.dirname, '../../../../agent');
const HOSTNAME = `agent.${CELL_ID}.silohq.io`;
const BROKER_PORT = 51883;
const SPARKPLUG_GROUP = `Plant${Date.now().toString(36)}`;
const TOPIC = `silo-e2e-${Date.now()}`;

/** An MQTT 3.1.1 publish at QoS 0, by hand: CONNECT, PUBLISH (retained or not), DISCONNECT. */
async function publish(topic: string, payload: string | Buffer, retained = true): Promise<void> {
  const remaining = (n: number): Buffer => {
    const out: number[] = [];
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      out.push(byte);
    } while (n > 0);
    return Buffer.from(out);
  };
  const str = (s: string): Buffer => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b]);
  };
  const connectBody = Buffer.concat([str('MQTT'), Buffer.from([4, 0x02, 0, 60]), str(`pub${Date.now()}${Math.random().toString(16).slice(2, 8)}`)]);
  const publishBody = Buffer.concat([str(topic), typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload]);
  await new Promise<void>((resolve, reject) => {
    const socket = tcp({ host: '127.0.0.1', port: BROKER_PORT }, () => {
      socket.write(Buffer.concat([Buffer.from([0x10]), remaining(connectBody.length), connectBody]));
    });
    socket.once('data', (ack) => {
      if (ack[0] !== 0x20 || ack[3] !== 0) return reject(new Error('the broker refused the publisher'));
      socket.write(Buffer.concat([Buffer.from([retained ? 0x31 : 0x30]), remaining(publishBody.length), publishBody]));
      socket.end(Buffer.from([0xe0, 0x00]));
    });
    socket.once('close', () => resolve());
    socket.once('error', reject);
  });
}

const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
});

const live = hasGo && await reachable(BROKER_PORT);
let cell: ConnectCell;
let root: Signed;
let ops: Signed;
let tunnels: AgentTunnels | undefined;
let agent: ChildProcess | undefined;
let dir = '';
let poolId = '';
const logs: string[] = [];
const received: SourceChange[] = [];
let bus: LiveBus | undefined;
let state: RedisStore | undefined;

const manifest = (stream = false) => doc({
  schemaVersion: '1', identity: { name: 'Line telemetry', provider: 'Example plant', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'mqtt' }, auth: { strategy: 'none' },
  objects: [{
    name: 'readings', identifier: ['id'],
    fields: [{ name: 'id', type: 'string' }, { name: 'site', type: 'string' }, { name: 'line', type: 'string' }, { name: 'celsius', type: 'number' }],
    source: {
      kind: 'mqtt', topic: `${TOPIC}/site/+/line/+/temp`, snapshotMs: 1500,
      decode: { jsonata: '{ "id": topic[2] & "-" & topic[4], "site": topic[2], "line": topic[4], "celsius": payload.celsius }' },
    },
    // Commands (47.1): published to the topic naming the record, retained here so the test reads them back.
    writes: {
      risk: 'physical', bounds: { maxRows: 5 },
      custom: [{ name: 'run', mqtt: { topic: `${TOPIC}/cmd/{identifier}`, retained: true, schema: [{ name: 'run', type: 'boolean' }] }, body: { jsonata: '{"run": true}' } }],
    },
  }, {
    // Sparkplug B (20.2; D211): binary payloads, carried by the agent as they are, decoded by the cell.
    name: 'pumps', identifier: ['id'], fields: [{ name: 'id', type: 'string' }, { name: 'speed', type: 'number' }, { name: 'running', type: 'boolean' }],
    source: {
      kind: 'mqtt', topic: `spBv1.0/${SPARKPLUG_GROUP}/DDATA/+/+`, payload: 'sparkplug_b', snapshotMs: 1500,
      decode: { jsonata: '{ "id": payload.edgeNodeId & "/" & payload.deviceId, "speed": payload.values.Speed, "running": payload.values.Running }' },
    },
  }, {
    name: 'commands', identifier: ['id'], fields: [{ name: 'id', type: 'string' }, { name: 'run', type: 'boolean' }],
    source: { kind: 'mqtt', topic: `${TOPIC}/cmd/+`, snapshotMs: 1500, decode: { jsonata: '{ "id": topic[2], "run": payload.run }' } },
  }],
  ...(stream ? { changeStream: { objects: [{ object: 'readings', sources: [{ kind: 'mqtt' }] }] } } : {}),
});

async function connection(options: { pool: true; stream?: boolean }): Promise<string> {
  const gateway = cell.client('gateway');
  const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
  const connector = await gateway.call(createConnector, { body: { slug: `mqtt-${uuidv7().slice(-12)}`, name: 'Telemetry', provider: 'Example plant', sourceRoute: 'visual' } }, keyed());
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest(options.stream === true) } }, keyed());
  const created = await gateway.call(createConnection, {
    body: { connectorId: connector.id, name: 'Telemetry', owningScopeId: cell.scopes['engineering']!, ...(options.pool ? { agentPoolId: poolId } : {}) },
  }, keyed());
  return created.id;
}

before(async () => {
  if (!live) return;
  dir = await mkdtemp(path.join(tmpdir(), 'silo-agent-mqtt-'));
  const binary = path.join(dir, 'silo-agent');
  execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/silo-agent'], { cwd: AGENT_DIR, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'pipe' });
  cell = await createConnectCell();
  root = await cell.signIn('root@acme.example');
  const ca = await testAgentCa();
  const tls = await testEndpointTls(HOSTNAME);
  await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
  await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
  let port = 0;
  // A service finds those started before it: connect-runtime reports captures to change-stream.
  const liveEnv = { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl };
  await cell.start(createChangeStreamService({ tickMs: 150 }), 'change-stream', 'test_app', liveEnv);
  await cell.start(createConnectRuntimeService({
    onAgentEndpoint: (p) => { port = p; }, onAgentTunnels: (t) => { tunnels = t; }, agentHeartbeatMs: 200, agentCaptureLeaseMs: 3_000, agentCaptureRetryMs: 300,
  }),
    'connect-runtime', 'test_app', {
      AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
      AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem,
    });
  await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
  await cell.start(evaluatorService, 'expression-evaluator', 'test_app');
  await cell.start(approvalsService, 'approvals', 'test_app');
  await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app');
  ops = await cell.member('ops@acme.example', 'Physical operations');
  const gateway = cell.client('gateway');
  poolId = (await gateway.call(createAgentPool, { body: { name: 'Plant', environment: 'production' } }, cell.as(root))).id;
  const config = path.join(dir, 'agent.json');
  await writeFile(config, JSON.stringify({
    endpoint: `127.0.0.1:${port}`, serverName: HOSTNAME, endpointCaFile: path.join(dir, 'endpoint.pem'), stateDir: path.join(dir, 'state'),
    name: 'plant-a', healthListen: `127.0.0.1:${await freePort()}`, targets: ['127.0.0.1'],
  }));
  await chmod(config, 0o600);
  const { token } = await gateway.call(issueAgentEnrolmentToken, { params: { poolId } }, cell.as(root));
  await run(binary, ['enrol', '-config', config, '-token', token]);
  agent = spawn(binary, ['run', '-config', config, '-heartbeat', '200ms'], { stdio: ['ignore', 'pipe', 'pipe'] });
  agent.stdout!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  agent.stderr!.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  const deadline = Date.now() + 30_000;
  while ((tunnels?.connected(cell.org, poolId).filter((a) => a.healthy).length ?? 0) !== 1) {
    if (Date.now() > deadline) assert.fail(`the agent did not connect\n${logs.slice(-10).join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await publish(`${TOPIC}/site/1/line/4/temp`, '{"celsius":21.5}');
  await publish(`${TOPIC}/site/2/line/7/temp`, '{"celsius":19}');
  await publish(`${TOPIC}/site/2/other`, '{"x":1}');
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
});

after(async () => {
  agent?.kill('SIGTERM');
  await bus?.close();
  await state?.close();
  await cell?.close();
  if (dir !== '') await rm(dir, { recursive: true, force: true });
});

describe('industrial endpoints (spec 20.1 to 20.3, 20.7)', { skip: !live && 'needs Go and the MQTT broker (docker compose up -d mqtt)' }, () => {
  test('an endpoint is reached through the agent pool, serves the protocol its manifest speaks, by the scheme and policy MQTT takes', async () => {
    const gateway = cell.client('gateway');
    const create = (connectionId: string, body: Record<string, unknown>) =>
      gateway.call(createIndustrialEndpoint, { params: { connectionId }, body: body as never }, cell.as(root));
    // A connection without a pool cannot exist for an agent manifest (createConnection refuses it); the endpoint checks again.
    const pooled = await connection({ pool: true });
    await assert.rejects(create(pooled, { plugin: 'mqtt', endpointUrl: 'tcp://127.0.0.1:1883', securityPolicy: 'tls' }), { code: 'industrial.policy_invalid' });
    await assert.rejects(create(pooled, { plugin: 'mqtt', endpointUrl: 'opc.tcp://127.0.0.1:1883', securityPolicy: 'plain' }), { code: 'industrial.url_scheme' });
    await assert.rejects(create(pooled, { plugin: 'opcua', endpointUrl: 'opc.tcp://127.0.0.1:4840', securityPolicy: 'None', insecureException: true }),
      { code: 'industrial.plugin_mismatch' });
    await create(pooled, { plugin: 'mqtt', endpointUrl: 'ssl://127.0.0.1:8883', securityPolicy: 'tls' });
    const listed = await gateway.call(listIndustrialEndpoints, { params: { connectionId: pooled } }, cell.as(root));
    assert.deepEqual(listed.endpoints.map((e) => [e.plugin, e.agentPoolId, e.insecureExceptionBy]), [['mqtt', poolId, null]]);
    const { rows } = await cell.migrate.query(
      `select payload->>'event' as event from platform.outbox where organisation_id = $1 and payload->>'event' in ('industrial_endpoint_created', 'opcua_insecure_exception_recorded')
       and payload->'resource'->>'id' = $2 order by seq`, [cell.org, pooled]);
    assert.deepEqual(rows.map((r) => r.event), ['industrial_endpoint_created']);
  });

  test('MQTT: the broker\'s retained messages on the topic filter, read by the agent, decoded by the cell', async () => {
    const gateway = cell.client('gateway');
    const id = await connection({ pool: true });
    await gateway.call(createIndustrialEndpoint, { params: { connectionId: id }, body: { plugin: 'mqtt', endpointUrl: `tcp://127.0.0.1:${BROKER_PORT}`, securityPolicy: 'plain' } }, cell.as(root));
    let version = (await cell.migrate.query('select version from connect.connections where id = $1', [id])).rows[0].version as number;
    for (const move of ['probe', 'confirm', 'activate'] as const) {
      if (move === 'confirm') await cell.passConformance(id);
      version = (await gateway.call(changeConnectionStatus, { params: { connectionId: id }, body: { move, version } }, cell.as(root))).version;
    }
    const out = await cell.client('executor').call(readObject, { body: { connectionId: id, reason: 'query', step: { object: 'readings' } } }, cell.as(root));
    assert.deepEqual([...out.rows].sort((a, b) => String(a['id']).localeCompare(String(b['id']))), [
      { id: '1-4', site: '1', line: '4', celsius: 21.5 },
      { id: '2-7', site: '2', line: '7', celsius: 19 },
    ], logs.slice(-5).join(''));
    // A Sparkplug B DDATA, retained on the broker: bytes the agent carries untouched, decoded by metric name.
    const metric = (name: string, datatype: number, value: Buffer) => {
      const n = Buffer.from(name);
      const body = Buffer.concat([Buffer.from([0x0a, n.length]), n, Buffer.from([0x20, datatype]), value]);
      return Buffer.concat([Buffer.from([0x12, body.length]), body]);
    };
    const speed = Buffer.alloc(9); speed[0] = 0x69; speed.writeDoubleLE(1450.5, 1);
    await publish(`spBv1.0/${SPARKPLUG_GROUP}/DDATA/Edge7/Pump3`, Buffer.concat([metric('Speed', 10, speed), metric('Running', 11, Buffer.from([0x70, 0x01]))]));
    const pumps = await cell.client('executor').call(readObject, { body: { connectionId: id, reason: 'query', step: { object: 'pumps' } } }, cell.as(root));
    assert.deepEqual(pumps.rows, [{ id: 'Edge7/Pump3', speed: 1450.5, running: true }], logs.slice(-5).join(''));
  });

  test('MQTT telemetry: the agent holding the capture subscribes and sends messages up as they arrive; published live, never spooled', async () => {
    const gateway = cell.client('gateway');
    const id = await connection({ pool: true, stream: true });
    await gateway.call(createIndustrialEndpoint, { params: { connectionId: id }, body: { plugin: 'mqtt', endpointUrl: `tcp://127.0.0.1:${BROKER_PORT}`, securityPolicy: 'plain' } }, cell.as(root));
    let version = (await cell.migrate.query('select version from connect.connections where id = $1', [id])).rows[0].version as number;
    for (const move of ['probe', 'confirm', 'activate'] as const) {
      if (move === 'confirm') await cell.passConformance(id);
      version = (await gateway.call(changeConnectionStatus, { params: { connectionId: id }, body: { move, version } }, cell.as(root))).version;
    }
    await registerChangeInterest(state!, CELL_ID, cell.org, id, ['readings']);
    const slotName = `silo_${Date.now()}`;
    await gateway.call(setChangeCapture, { params: { connectionId: id }, body: { slotName, confirmed: true } }, cell.as(root));
    const deadline = Date.now() + 30_000;
    const live = async () => (await gateway.call(getStreamStatus, { params: { connectionId: id } }, cell.as(root))).objects[0];
    while ((await live())?.status !== 'live' || (await live())?.inUse !== 'mqtt') {
      if (Date.now() > deadline) assert.fail(`the subscription did not start: ${JSON.stringify(await live())}\n${logs.slice(-8).join('')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await publish(`${TOPIC}/site/3/line/1/temp`, '{"celsius":30}', false);
    await publish(`${TOPIC}/site/3/line/1/temp`, '{"celsius":31}', false);
    const arrived = () => received.filter((d) => d.connectionId === id && d.entityRef === '3-1');
    const until = Date.now() + 15_000;
    while (!arrived().some((d) => (d.changed as Record<string, unknown>)['celsius'] === 31)) {
      if (Date.now() > until) assert.fail(`no delta arrived: ${JSON.stringify(received.slice(-3))}\n${logs.slice(-8).join('')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const delta = arrived().find((d) => (d.changed as Record<string, unknown>)['celsius'] === 30)!;
    assert.deepEqual([delta.source, delta.object, (delta.changed as Record<string, unknown>)['site']], ['mqtt', 'readings', '3']);
    const { rows } = await cell.migrate.query('select id, method, leased_by_agent_id from connect.cdc_slots where connection_id = $1', [id]);
    assert.deepEqual([rows[0].method, rows[0].leased_by_agent_id !== null], ['mqtt', true]);
    // Telemetry never reaches the agent's disk (20.6): no spool for the capture.
    const spooled = await readdir(path.join(dir, 'state', 'spool')).catch(() => [] as string[]);
    assert.ok(!spooled.some((name) => name.includes(rows[0].id)), `spooled: ${spooled.join(', ')}`);
  });

  test('commands: published by the agent on a signed grant, to topics in its signed allow-list only, outside their interval (spec 47.1, 47.4)', async () => {
    const gateway = cell.client('gateway');
    const id = await connection({ pool: true });
    await gateway.call(createIndustrialEndpoint, { params: { connectionId: id }, body: { plugin: 'mqtt', endpointUrl: `tcp://127.0.0.1:${BROKER_PORT}`, securityPolicy: 'plain' } }, cell.as(root));
    let version = (await cell.migrate.query('select version from connect.connections where id = $1', [id])).rows[0].version as number;
    for (const move of ['probe', 'confirm', 'activate'] as const) {
      if (move === 'confirm') await cell.passConformance(id);
      version = (await gateway.call(changeConnectionStatus, { params: { connectionId: id }, body: { move, version } }, cell.as(root))).version;
    }
    await cell.migrate.query('update connect.connections set writes_enabled = true, max_physical_writes_per_minute = 10 where id = $1', [id]);
    const command = `${TOPIC}/cmd/1-4`;
    await gateway.call(declareWritablePoint, { params: { connectionId: id }, body: { address: command, valueCheck: { cel: 'true' }, settleSeconds: 0, testSafe: false } }, cell.as(root));
    const asked = await gateway.call(requestAllowlistEntry, {
      params: { connectionId: id }, body: { nodeAddress: command, kind: 'command', dataType: 'Boolean', minIntervalSeconds: 60, objectId: uuidv7() },
    }, cell.as(root));
    await gateway.call(decideAllowlistRequest, { params: { requestId: asked.id }, body: { decision: 'approve' } }, cell.as(ops));
    const delivered = Date.now() + 15_000;
    while ((await cell.migrate.query(
      `select 1 from platform.outbox where organisation_id = $1 and payload->>'event' = 'allowlist_delivered_to_agent' and payload->'detail'->>'connection_id' = $2`, [cell.org, id])).rowCount === 0) {
      if (Date.now() > delivered) assert.fail(`the list did not reach the agent\n${logs.slice(-6).join('')}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const actions = cell.client('actions');
    const signer = createGrantSigner(createPrivateKey(TEST_GRANT_KEYS.privateKey));
    const send = async (record: string) => {
      const plan = {
        connectionId: id, object: 'readings', at: new Date().toISOString(),
        operations: [{ key: uuidv7(), operation: 'custom' as const, identifier: record, customAction: 'run', values: {} }],
      };
      const prepared = await actions.call(prepareWrites, { body: plan }, cell.as(root));
      const grant = signer.sign({
        organisationId: cell.org, actionId: uuidv7(), actionKind: 'mutation', connectionId: id, object: 'readings',
        statements: prepared.statements!, payloadSha256: prepared.payloadSha256!,
      });
      return (await actions.call(writeRecords, { body: { ...plan, grant } }, cell.as(root))).results[0]!;
    };
    // Listed: published, acknowledged by the broker, and there (retained) when read.
    const sent = await send('1-4');
    assert.deepEqual([sent.outcome, sent.physical?.nodes.map((n) => [n.nodeAddress, n.status])], ['applied', [[command, 'good']]], logs.slice(-4).join(''));
    const read = await cell.client('executor').call(readObject, { body: { connectionId: id, reason: 'query', step: { object: 'commands' } } }, cell.as(root));
    assert.deepEqual(read.rows, [{ id: '1-4', run: true }]);
    // Inside the entry's interval, and a topic not in the signed list: refused by the agent, nothing published.
    const tooSoon = await send('1-4');
    assert.deepEqual([tooSoon.outcome, tooSoon.error?.code, tooSoon.physical?.reason], ['failed', 'actuation.refused_by_agent', 'interval']);
    const unlisted = await send('2-7');
    assert.deepEqual([unlisted.outcome, unlisted.physical?.reason], ['failed', 'not_listed']);
  });
});
