// The actuation allow-list (spec 47.4, 47.7, 47.8): an entry for a declared physical writable
// point, asked by the connection's owner, approved by another person, one of the two holding
// actuation.approve, signed by the control plane over its canonical text; never an interlock
// or protection setting; removed, never edited. Real processes: credential, policy, auth,
// connect-registry, actions.

import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { issueAgentEnrolmentToken } from '../../src/contracts/connect-registry/agent.contract.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import type { AgentTunnels } from '../../src/services/connect-runtime/agentTunnels.service.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { testAgentCa, testEndpointTls } from './agent.helper.ts';
import { hasGo, run } from './agentSource.helper.ts';
import {
  ALLOWLIST_ENTRY_PREFIX, decideAllowlistRequest, listAllowlist, removeAllowlistEntry, requestAllowlistEntry,
} from '../../src/contracts/actions/allowlist.contract.ts';
import { createAgentPool } from '../../src/contracts/connect-registry/agent.contract.ts';
import { createConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { declareWritablePoint } from '../../src/contracts/connect-registry/writablePoint.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { allowlistEntryText, protectiveName } from '../../src/services/actions/allowlist.service.ts';
import { verifyInstruction } from '../../src/utils/signedInstruction.util.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, TEST_GRANT_KEYS, type ConnectCell, type Signed } from './connect.helper.ts';

const PLANT = 'urn:silo:test:plant';
const SPEED = `nsu=${PLANT};s=Pump1.Motor.Speed`;
const START = `nsu=${PLANT};s=Pump1.Start`;
const ALARM = `nsu=${PLANT};s=Pump1.HighAlarmLimit`;

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let ops: Signed;
let admin: Signed;
let owner: Signed;
let poolId: string;
let connectionId: string;

const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });

const manifest = () => doc({
  schemaVersion: '1', identity: { name: 'Pump house', provider: 'Example plant', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'opc_ua' }, auth: { strategy: 'none' },
  objects: [{
    name: 'pumps', identifier: ['id'], fields: [{ name: 'id', type: 'string', path: '$browseName' }, { name: 'rpm', type: 'integer', path: 'Motor/Speed' }],
    source: { kind: 'opc_ua', root: `nsu=${PLANT};s=Pumps` },
  }],
});

const speedEntry = { nodeAddress: SPEED, kind: 'setpoint', dataType: 'Int32', minValue: '0', maxValue: '1800.50', maxStep: '200', minIntervalSeconds: 30, objectId: uuidv7() } as const;

before(async () => {
  cell = await createConnectCell();
  await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app');
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  // Physical operations holds actuation.approve alone; a second super admin owns connections but
  // holds no actuation.approve (47.8); an admin holds neither.
  ops = await cell.member('ops@acme.example', 'Physical operations');
  owner = await cell.member('owner@acme.example', 'Super admin');
  admin = await cell.member('adm@acme.example', 'Admin', 'engineering');
  poolId = (await gateway.call(createAgentPool, { body: { name: 'Pump house', environment: 'production' } }, cell.as(root))).id;
  const connector = await gateway.call(createConnector, { body: { slug: `al-${uuidv7().slice(-12)}`, name: 'Pumps', provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest() } }, keyed(root));
  connectionId = (await gateway.call(createConnection, {
    body: { connectorId: connector.id, name: 'Pumps', owningScopeId: cell.scopes['engineering']!, agentPoolId: poolId },
  }, keyed(root))).id;
  for (const address of [SPEED, START, ALARM]) {
    await gateway.call(declareWritablePoint, {
      params: { connectionId }, body: { address, valueCheck: { cel: 'true' }, settleSeconds: 0, testSafe: false },
    }, cell.as(root));
  }
});

let agent: ChildProcess | undefined;
let dir = '';
const logs: string[] = [];

after(async () => {
  agent?.kill('SIGTERM');
  await cell?.close();
  if (dir !== '') await rm(dir, { recursive: true, force: true });
});

describe('the actuation allow-list (spec 47.4, 47.7, 47.8)', () => {
  test('protective nodes are named by their own words: never listed', () => {
    assert.deepEqual([ALARM, `nsu=${PLANT};s=ESD_Valve`, 'plant/pump/EStop', `nsu=${PLANT};s=Interlock.Bypass`].map(protectiveName), [true, true, true, true]);
    assert.deepEqual([SPEED, `nsu=urn:acme:limited;s=Pump1.Speed`, `nsu=${PLANT};s=Stripper.Temp`, 'plant/Pressure_Stop'].map(protectiveName), [false, false, false, false]);
  });

  test('two people, one holding actuation.approve: the entry is signed over its canonical text', async () => {
    const request = (who: Signed, body: Record<string, unknown>) =>
      gateway.call(requestAllowlistEntry, { params: { connectionId }, body: body as never }, cell.as(who));
    await assert.rejects(request(root, { ...speedEntry, nodeAddress: `nsu=${PLANT};s=Pump2.Motor.Speed` }), { code: 'actuation.point_not_declared' });
    await assert.rejects(request(root, { ...speedEntry, nodeAddress: ALARM }), { code: 'actuation.protective_node' });
    await assert.rejects(request(root, { ...speedEntry, nodeAddress: START, kind: 'command', maxStep: undefined }), { code: 'actuation.range_not_setpoint' });
    await assert.rejects(request(ops, speedEntry), { code: 'actuation.not_owner' }, 'asking is the connection owner\'s');

    const asked = await request(root, speedEntry);
    assert.equal(asked.status, 'pending');
    const decide = (who: Signed, decision: 'approve' | 'reject') =>
      gateway.call(decideAllowlistRequest, { params: { requestId: asked.id }, body: { decision } }, cell.as(who));
    await assert.rejects(decide(root, 'approve'), { code: 'actuation.self_approval' });
    await assert.rejects(decide(admin, 'approve'), { code: 'actuation.not_decider' });
    await assert.rejects(decide(owner, 'approve'), { code: 'actuation.approver_required' }, 'neither owner holds actuation.approve');
    const { request: decided, entry } = await decide(ops, 'approve');
    assert.deepEqual([decided.status, decided.entryId, entry!.addedBy, entry!.approvedBy], ['approved', entry!.id, root.membershipId, ops.membershipId]);
    assert.deepEqual([entry!.minValue, entry!.maxValue, entry!.maxStep], ['0', '1800.5', '200']);
    await assert.rejects(decide(ops, 'reject'), { code: 'actuation.request_decided' });

    // The signature is the control plane's over the entry's canonical text, read back from the database.
    const { rows } = await cell.migrate.query('select * from action.actuation_allowlists where id = $1', [entry!.id]);
    const row = rows[0];
    const text = allowlistEntryText({
      id: row.id, organisationId: row.organisation_id, connectionId: row.connection_id, transport: row.transport, nodeAddress: row.node_address,
      kind: row.kind, dataType: row.data_type, minValue: row.min_value, maxValue: row.max_value, maxStep: row.max_step,
      minIntervalSeconds: row.min_interval_seconds, inverseCommand: row.inverse_command, simulatorAddress: row.simulator_address,
      objectId: row.object_id, addedBy: row.added_by, approvedBy: row.approved_by, approvedAt: new Date(row.approved_at).toISOString(),
    });
    assert.ok(verifyInstruction(ALLOWLIST_ENTRY_PREFIX, text, (row.signature as Buffer).toString('base64url'), createPublicKey(TEST_GRANT_KEYS.publicKey)));
    assert.ok(!verifyInstruction(ALLOWLIST_ENTRY_PREFIX, text.replace('"200"', '"2000"'), (row.signature as Buffer).toString('base64url'), createPublicKey(TEST_GRANT_KEYS.publicKey)));
    // Signed entries change only by removal.
    await assert.rejects(cell.migrate.query('update action.actuation_allowlists set max_value = 5000 where id = $1', [entry!.id]), /only removed_at may be set/);

    await assert.rejects(request(root, speedEntry), { code: 'actuation.entry_exists' });
    const { entries } = await gateway.call(listAllowlist, { params: { connectionId } }, cell.as(ops));
    assert.deepEqual(entries.map((e) => e.nodeAddress), [SPEED]);
    const events = await cell.migrate.query(
      `select payload->>'event' as event from platform.outbox where organisation_id = $1 and payload->>'event' like 'allowlist_%' order by seq`, [cell.org]);
    assert.deepEqual(events.rows.map((r) => r.event), ['allowlist_entry_requested', 'allowlist_entry_added', 'allowlist_signed']);
  });

  test('a request is rejected by another person; an entry is removed, never edited', async () => {
    const asked = await gateway.call(requestAllowlistEntry, {
      params: { connectionId }, body: { nodeAddress: START, kind: 'command', dataType: 'Boolean', minIntervalSeconds: 60, objectId: uuidv7() },
    }, cell.as(root));
    const rejected = await gateway.call(decideAllowlistRequest, { params: { requestId: asked.id }, body: { decision: 'reject' } }, cell.as(owner));
    assert.deepEqual([rejected.request.status, rejected.entry], ['rejected', null]);
    const { entries } = await gateway.call(listAllowlist, { params: { connectionId } }, cell.as(root));
    const removed = await gateway.call(removeAllowlistEntry, { params: { entryId: entries[0]!.id } }, cell.as(ops));
    assert.notEqual(removed.removedAt, null);
    await assert.rejects(gateway.call(removeAllowlistEntry, { params: { entryId: entries[0]!.id } }, cell.as(ops)), { code: 'actuation.entry_removed' });
    assert.deepEqual((await gateway.call(listAllowlist, { params: { connectionId } }, cell.as(root))).entries, []);
  });
});

describe('delivered to the Silo Agent (spec 47.4)', { skip: !hasGo && 'needs Go to build the agent' }, () => {
  before(async () => {
    const AGENT_DIR = path.resolve(import.meta.dirname, '../../../../agent');
    const HOSTNAME = `agent.${CELL_ID}.silohq.io`;
    dir = await mkdtemp(path.join(tmpdir(), 'silo-agent-allowlist-'));
    const binary = path.join(dir, 'silo-agent');
    execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/silo-agent'], { cwd: AGENT_DIR, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'pipe' });
    const ca = await testAgentCa();
    const tls = await testEndpointTls(HOSTNAME);
    await writeFile(path.join(dir, 'ca.pem'), ca.certificatePem);
    await writeFile(path.join(dir, 'endpoint.pem'), tls.cert);
    let port = 0;
    let tunnels: AgentTunnels | undefined;
    await cell.start(createConnectRuntimeService({
      onAgentEndpoint: (p) => { port = p; }, onAgentTunnels: (t) => { tunnels = t; }, agentHeartbeatMs: 200, agentAllowlistResendMs: 500,
    }), 'connect-runtime', 'test_app', {
      AGENT_ENDPOINT_PORT: '0', AGENT_ENDPOINT_TLS_CERT_FILE: path.join(dir, 'endpoint.pem'), AGENT_ENDPOINT_TLS_KEY: tls.key,
      AGENT_CA_CERT_FILE: path.join(dir, 'ca.pem'), AGENT_CA_KEY: ca.keyPem,
    });
    const health = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => { const { port: p } = server.address() as { port: number }; server.close(() => resolve(p)); });
    });
    const config = path.join(dir, 'agent.json');
    await writeFile(config, JSON.stringify({
      endpoint: `127.0.0.1:${port}`, serverName: HOSTNAME, endpointCaFile: path.join(dir, 'endpoint.pem'), stateDir: path.join(dir, 'state'),
      name: 'pump-house', healthListen: `127.0.0.1:${health}`, targets: ['127.0.0.1'],
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
  });

  test('an approved entry reaches the agent, which checks its signature; a removal empties its list', async () => {
    const deliveries = async () => (await cell.migrate.query(
      `select (payload->'detail'->>'entries')::int as entries from platform.outbox where organisation_id = $1 and payload->>'event' = 'allowlist_delivered_to_agent'
         and payload->'detail'->>'connection_id' = $2 order by seq`, [cell.org, connectionId])).rows.map((r) => r.entries as number);
    const until = async (want: number[]) => {
      const end = Date.now() + 15_000;
      while (JSON.stringify(await deliveries()) !== JSON.stringify(want)) {
        if (Date.now() > end) assert.fail(`deliveries ${JSON.stringify(await deliveries())}, wanted ${JSON.stringify(want)}\n${logs.slice(-6).join('')}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const asked = await gateway.call(requestAllowlistEntry, { params: { connectionId }, body: speedEntry as never }, cell.as(root));
    const { entry } = await gateway.call(decideAllowlistRequest, { params: { requestId: asked.id }, body: { decision: 'approve' } }, cell.as(ops));
    await until([1]);
    assert.ok(logs.join('').includes('agent.allowlist_taken'), 'the agent took the list');
    assert.ok(!logs.join('').includes('agent.allowlist_refused'), 'nothing the control plane signed is refused');
    await gateway.call(removeAllowlistEntry, { params: { entryId: entry!.id } }, cell.as(ops));
    await until([1, 0]);
  });
});
