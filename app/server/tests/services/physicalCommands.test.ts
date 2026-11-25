// Physical commands end to end in the cell (spec 47.1, 47.3, 47.4, 47.6): starting a pump over
// OPC UA (a method call, reverted by its inverse, the stop its allow-list entry names), jogging
// one (not reversible: the preview says so and a revert is refused), ramping one (a method with
// input arguments, each within the bounds its signed entry gives, D245), and running a line over MQTT
// (a command published to the topic its record names, with a payload its schema declares). A
// command is listed as a method (OPC UA) or a command (MQTT), checked at intent, sent once two
// people approve, and verified by acknowledgement, which its receipt says does not confirm the
// physical outcome. The agent is a fake here: its own checks run against the real agent in the Go
// tests (internal/work: TestOPCUACall, TestMQTTPublish). Real processes: credential, policy,
// auth, connect-registry, connect-runtime, ontology, approvals, actions, revert.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { decideAllowlistRequest, requestAllowlistEntry } from '../../src/contracts/actions/allowlist.contract.ts';
import { proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, getReceipt, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { createAgentPool } from '../../src/contracts/connect-registry/agent.contract.ts';
import { changeConnectionStatus, createConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { createIndustrialEndpoint } from '../../src/contracts/connect-registry/industrial.contract.ts';
import { declareWritablePoint } from '../../src/contracts/connect-registry/writablePoint.contract.ts';
import { putObjectType } from '../../src/contracts/ontology/element.contract.ts';
import { approveProposal, mergeProposal, openBranch, submitProposal } from '../../src/contracts/ontology/proposal.contract.ts';
import { grantConnection } from '../../src/contracts/policy/governance.contract.ts';
import { grantRole } from '../../src/contracts/policy/admin.contract.ts';
import { requestRevert } from '../../src/contracts/revert/revert.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { service as revertService } from '../../src/routes/revert/index.route.ts';
import { COMMAND_ACKNOWLEDGEMENT, NOT_REVERTIBLE_STATEMENT, PHYSICAL_STATEMENT } from '../../src/services/actions/physical.service.ts';
import type { AgentChannel, AgentPhysicalResult, AgentCallStatement, AgentPublishStatement } from '../../src/services/connect-runtime/agent.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';
import { freePort } from './writeback.helper.ts';

const PLANT = 'urn:silo:test:plant';
const method = (pump: string, name: string) => `nsu=${PLANT};s=${pump}.Motor.${name}`;
const topic = (line: string) => `site/a/line/${line}/cmd`;

// The plant the fake agent calls and the broker it publishes to.
const running: Record<string, boolean> = { Pump1: true, Pump2: false };
const published: AgentPublishStatement[] = [];
const called: AgentCallStatement[] = [];
const entries: Record<string, string> = {};
let rejectJog = false;

const agent: AgentChannel = {
  async query() { throw new Error('no SQL here'); },
  async opcua(input) {
    // Each instance's speed, and any path's node by its browse names (a method's as a variable's).
    const rows = Object.keys(running).map((pump) => Object.fromEntries(input.paths.map((p) => [p,
      p === '$browseName' ? pump : p === 'Motor/Speed' ? 0 : p.endsWith('/$nodeId') ? `nsu=${PLANT};s=${pump}.${p.slice(0, -'/$nodeId'.length).replaceAll('/', '.')}` : null])));
    return { rows, truncated: false };
  },
  async opcuaCall(input) {
    called.push(...input.statements);
    return input.statements.map((s): AgentPhysicalResult => {
      const name = s.method.split('/').at(-1)!;
      const rejected = name === 'Jog' && rejectJog;
      const nodes = [{ path: s.method, nodeAddress: method(s.instance, name), entryId: entries[method(s.instance, name)] ?? '', status: rejected ? 'bad' : 'good' }];
      if (rejected) return { key: s.key, outcome: 'rejected', nodes };
      if (name === 'Start' || name === 'Stop') running[s.instance] = name === 'Start';
      return { key: s.key, outcome: 'applied', nodes };
    });
  },
  async mqtt() {
    const at = new Date().toISOString();
    return {
      messages: ['4', '5'].map((line) => ({ topic: `site/a/line/${line}/state`, payload: Buffer.from('{"state":"idle"}').toString('base64'), retained: true, receivedAt: at })), truncated: false,
    };
  },
  async mqttPublish(input) {
    published.push(...input.statements);
    return input.statements.map((s): AgentPhysicalResult => ({
      key: s.key, outcome: 'applied',
      nodes: [{ path: s.topic, nodeAddress: s.topic, entryId: entries[s.topic] ?? '', status: 'good', ...(s.dryRun === true ? { simulatorAddress: `sim/${s.topic}` } : {}) }],
    }));
  },
};

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let ops: Signed;
let second: Signed;
let pumps: string;
let lines: string;
const types: Record<string, string> = {};
let startedPump2 = '';

const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });

const pumpManifest = () => doc({
  schemaVersion: '1', identity: { name: 'Pump house', provider: 'Example plant', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'opc_ua' }, auth: { strategy: 'none' },
  objects: [{
    name: 'pumps', identifier: ['id'],
    fields: [{ name: 'id', type: 'string', path: '$browseName' }, { name: 'rpm', type: 'integer', path: 'Motor/Speed' }],
    source: { kind: 'opc_ua', root: `nsu=${PLANT};s=Pumps` },
    writes: {
      risk: 'physical', bounds: { maxRows: 10 },
      custom: [
        { name: 'start', opcua: { method: 'Motor/Start' }, compensatedBy: 'stop' },
        { name: 'stop', opcua: { method: 'Motor/Stop' }, compensatedBy: 'start' },
        { name: 'jog', opcua: { method: 'Motor/Jog' } },
        { name: 'ramp', opcua: { method: 'Motor/Ramp', arguments: [{ name: 'Rpm', type: 'Int32', input: 'rpm' }, { name: 'Mode', type: 'String', input: 'mode' }] } },
      ],
    },
  }],
});

const lineManifest = () => doc({
  schemaVersion: '1', identity: { name: 'Lines', provider: 'Example plant', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'mqtt' }, auth: { strategy: 'none' },
  objects: [{
    name: 'lines', identifier: ['line'], fields: [{ name: 'line', type: 'string' }, { name: 'state', type: 'string' }],
    source: { kind: 'mqtt', topic: 'site/a/line/+/state', decode: { jsonata: '{"line": topic[3], "state": payload.state}' } },
    writes: {
      risk: 'physical', bounds: { maxRows: 5 },
      custom: [{
        name: 'run', mqtt: { topic: 'site/a/line/{identifier}/cmd', schema: [{ name: 'run', type: 'boolean' }, { name: 'speed', type: 'integer', required: false }] },
        body: { jsonata: '{"run": true, "speed": speed}' },
      }],
    },
  }],
});

/** A writable point and its signed allow-list entry, decided by a second person. */
async function allowlisted(connectionId: string, address: string, entry: Record<string, unknown>, valueCheck = 'true'): Promise<void> {
  await gateway.call(declareWritablePoint, {
    params: { connectionId }, body: { address, valueCheck: { cel: valueCheck }, settleSeconds: 0, testSafe: false },
  }, cell.as(root)).catch((error: { code?: string }) => { if (error.code !== 'industrial.point_exists') throw error; });
  const asked = await gateway.call(requestAllowlistEntry, {
    params: { connectionId }, body: { nodeAddress: address, dataType: 'Boolean', objectId: uuidv7(), minIntervalSeconds: 0, ...entry } as never,
  }, cell.as(root));
  const decided = await gateway.call(decideAllowlistRequest, { params: { requestId: asked.id }, body: { decision: 'approve' } }, cell.as(ops));
  entries[address] = decided.entry!.id;
}

async function connection(name: string, manifest: ReturnType<typeof doc>, endpoint: Record<string, unknown>, poolId: string): Promise<string> {
  const connector = await gateway.call(createConnector, { body: { slug: `pc-${uuidv7().slice(-12)}`, name, provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest } }, keyed(root));
  let created = await gateway.call(createConnection, {
    body: { connectorId: connector.id, name, owningScopeId: cell.scopes['engineering']!, agentPoolId: poolId },
  }, keyed(root));
  await gateway.call(createIndustrialEndpoint, { params: { connectionId: created.id }, body: endpoint as never }, cell.as(root));
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(created.id);
    created = await gateway.call(changeConnectionStatus, { params: { connectionId: created.id }, body: { move, version: created.version } }, cell.as(root));
  }
  await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    'update connect.connections set writes_enabled = true, max_physical_writes_per_minute = 10 where id = $1', [created.id]));
  for (const who of [ops, second]) {
    await gateway.call(grantConnection, { body: { connectionId: created.id, grantee: { kind: 'membership', id: who.membershipId }, access: 'read' } }, cell.as(root));
  }
  return created.id;
}

const propose = (type: string, connectionId: string, reference: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  gateway.call(proposeMutation, { body: { actionTypeId: types[type]!, parameters, objects: [{ connectionId, reference }], ...extra } as never }, keyed(root));

async function approved(m: MutationView): Promise<MutationView> {
  for (const who of [ops, second]) {
    await gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, cell.as(who));
  }
  for (let i = 0; i < 100; i++) {
    const done = await gateway.call(getMutation, { params: { mutationId: m.id } }, cell.as(root));
    if (done.completedAt !== null) return done;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the mutation did not finish');
}

const events = async (name: string) => (await cell.migrate.query(
  `select payload->'detail' as detail, payload->'resource'->>'id' as resource from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by seq`,
  [cell.org, name])).rows as { detail: Record<string, unknown>; resource: string }[];

type ReceiptDocument = { acknowledgement?: string; verifications: { field: string | null; intended: unknown; observed: unknown; outcome: string; reason: string | null }[] };
const receiptOf = async (receiptId: string) => (await gateway.call(getReceipt, { params: { receiptId } }, cell.as(root))).document as ReceiptDocument;

before(async () => {
  cell = await createConnectCell();
  const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
  await cell.start(createConnectRuntimeService({ agent }), 'connect-runtime', 'test_app');
  await cell.start(ontologyService, 'ontology', 'test_app');
  await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
  await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
  await cell.start(revertService, 'revert', 'test_app');
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  ops = await cell.member('ops@acme.example', 'Super admin');
  await gateway.call(grantRole, { body: { membershipId: ops.membershipId, roleId: cell.roles['Physical operations']! } }, cell.as(root));
  second = await cell.member('second@acme.example', 'Super admin');

  const poolId = (await gateway.call(createAgentPool, { body: { name: 'Plant', environment: 'production' } }, cell.as(root))).id;
  pumps = await connection('Pumps', pumpManifest(), { plugin: 'opcua', endpointUrl: 'opc.tcp://10.0.0.5:4840', securityPolicy: 'None', insecureException: true }, poolId);
  lines = await connection('Lines', lineManifest(), { plugin: 'mqtt', endpointUrl: 'ssl://10.0.0.6:8883', securityPolicy: 'tls' }, poolId);

  // Pump2's start and stop are each other's inverse; Pump1's start names none; jog has no inverse at all.
  await allowlisted(pumps, method('Pump2', 'Start'), { kind: 'method', inverseCommand: method('Pump2', 'Stop'), minIntervalSeconds: 3_600 });
  await allowlisted(pumps, method('Pump2', 'Stop'), { kind: 'method', inverseCommand: method('Pump2', 'Start') });
  await allowlisted(pumps, method('Pump2', 'Jog'), { kind: 'method' });
  await allowlisted(pumps, method('Pump1', 'Start'), { kind: 'method' });
  await allowlisted(pumps, method('Pump2', 'Ramp'), {
    kind: 'method', arguments: [{ name: 'Rpm', dataType: 'Int32', minValue: '0', maxValue: '1500' }, { name: 'Mode', dataType: 'String', values: ['auto', 'manual'] }],
  });
  // Pump1's ramp is listed as if it took the speed alone: not what the method takes.
  await allowlisted(pumps, method('Pump1', 'Ramp'), { kind: 'method', arguments: [{ name: 'Rpm', dataType: 'Int32', minValue: '0', maxValue: '1500' }] });
  await allowlisted(lines, topic('4'), { kind: 'command', simulatorAddress: `sim/${topic('4')}` }, '!has(values.speed) || values.speed <= 100');

  // The ontology: a Pump and a Line, authored by one person and confirmed by another.
  const branch = await gateway.call(openBranch, { body: { name: 'plant' } }, keyed(second));
  for (const [apiName, connectionId, sourceObject, id] of [['pump', pumps, 'pumps', 'id'], ['line', lines, 'lines', 'line']] as const) {
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName }, body: {
      displayName: apiName, pluralName: `${apiName}s`, contributingObjects: [{ connectionId, sourceObject, identifierFieldPath: id }],
      properties: [{ apiName: `${apiName}_name`, displayName: 'Name', dataType: 'string', nullable: false, mappings: [{ connectionId, sourceObject, fieldPath: id }] }],
      primaryKey: `${apiName}_name`, title: `${apiName}_name`,
    } as never }, keyed(second));
  }
  const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Plant' } }, keyed(second));
  await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
  const merged = await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
  const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `select api_name, id from ontology.object_types where organisation_id = $1 and api_name in ('pump', 'line')`, [cell.org]));
  const typeOf = Object.fromEntries(rows.map((r) => [r.api_name, r.id]));

  const publish = async (apiName: string, objectTypeId: string, connectionId: string, definition: Record<string, unknown>) => {
    const type = await gateway.call(proposeActionType, { body: { apiName, displayName: apiName, owningScopeId: cell.scopes['engineering']! } }, keyed(root));
    await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: {
      ontologyVersionId: merged.version.id, objectTypeId, permittedConnections: [connectionId], riskClass: 'physical', ...definition,
    } as never }, keyed(root));
    types[apiName] = type.id;
  };
  await publish('start_pump', typeOf['pump'], pumps, { rules: [{ kind: 'invoke_custom', customAction: 'start' }], revertBehaviour: 'compensating' });
  await publish('jog_pump', typeOf['pump'], pumps, { rules: [{ kind: 'invoke_custom', customAction: 'jog' }], revertBehaviour: 'not_revertible' });
  await publish('ramp_pump', typeOf['pump'], pumps, {
    parameters: [{ name: 'rpm', type: 'decimal' }, { name: 'mode', type: 'string' }],
    rules: [{ kind: 'invoke_custom', customAction: 'ramp', inputs: { rpm: { parameter: 'rpm' }, mode: { parameter: 'mode' } } }], revertBehaviour: 'not_revertible',
  });
  await publish('run_line', typeOf['line'], lines, {
    parameters: [{ name: 'speed', type: 'decimal', required: false }],
    rules: [{ kind: 'invoke_custom', customAction: 'run', inputs: { speed: { parameter: 'speed' } } }], revertBehaviour: 'not_revertible',
  });
});

after(async () => {
  await cell?.close();
});

describe('physical commands (spec 47.1, 47.3, 47.4, 47.6)', () => {
  test('an Action type over a command reverts by its inverse or not at all; an OPC UA method takes the inputs it declares, exactly', async () => {
    const type = await gateway.call(proposeActionType, { body: { apiName: 'start_again', displayName: 'Start', owningScopeId: cell.scopes['engineering']! } }, keyed(root));
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(`select id from ontology.object_types where organisation_id = $1 and api_name = 'pump'`, [cell.org]));
    const versionOf = async (definition: Record<string, unknown>) => gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: {
      ontologyVersionId: (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
        `select id from ontology.ontology_versions where organisation_id = $1 order by created_at desc limit 1`, [cell.org]))).rows[0].id,
      objectTypeId: rows[0].id, permittedConnections: [pumps], riskClass: 'physical', ...definition,
    } as never }, keyed(root));
    await assert.rejects(versionOf({ rules: [{ kind: 'invoke_custom', customAction: 'start' }] }), { code: 'action_type.command_revert' });
    await assert.rejects(versionOf({ rules: [{ kind: 'invoke_custom', customAction: 'start' }], revertBehaviour: 'state_only' }), { code: 'action_type.command_revert' });
    await assert.rejects(versionOf({
      parameters: [{ name: 'n', type: 'integer' }], rules: [{ kind: 'invoke_custom', customAction: 'start', inputs: { n: { parameter: 'n' } } }], revertBehaviour: 'not_revertible',
    }), { code: 'action_type.inputs_mismatch' });
    await assert.rejects(versionOf({
      parameters: [{ name: 'rpm', type: 'integer' }], rules: [{ kind: 'invoke_custom', customAction: 'ramp', inputs: { rpm: { parameter: 'rpm' } } }], revertBehaviour: 'not_revertible',
    }), { code: 'action_type.inputs_mismatch' }, 'Ramp takes the mode too');
  });

  test('an allow-list entry bounds every input argument a method takes (D245): a number by its range, text by its values', async () => {
    const ask = (args: unknown) => gateway.call(requestAllowlistEntry, {
      params: { connectionId: pumps }, body: { nodeAddress: method('Pump2', 'Jog'), dataType: 'Boolean', objectId: uuidv7(), minIntervalSeconds: 0, kind: 'method', arguments: args } as never,
    }, cell.as(root));
    await assert.rejects(ask([{ name: 'Rpm', dataType: 'Int32' }]), { code: 'actuation.argument_range' });
    await assert.rejects(ask([{ name: 'Mode', dataType: 'String' }]), { code: 'actuation.argument_values' });
    await assert.rejects(ask([{ name: 'On', dataType: 'Boolean', values: ['yes'] }]), { code: 'actuation.argument_values' });
    await assert.rejects(ask([{ name: 'Rpm', dataType: 'Int32', minValue: '9', maxValue: '1' }]), { code: 'actuation.range_inverted' });
  });

  test('a method with input arguments: sent in the order it declares them, each within its signed bounds; otherwise refused at intent', async () => {
    const m = await propose('ramp_pump', pumps, 'Pump2', { rpm: 1200, mode: 'auto' });
    assert.equal(m.status, 'awaiting_approval', m.refusalReason ?? '');
    assert.deepEqual(m.preview!.physical!.nodes.map((n) => [n.command, n.nodeAddress, n.proposed]), [['ramp', method('Pump2', 'Ramp'), { Rpm: 1200, Mode: 'auto' }]]);
    const done = await approved(m);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.deepEqual(called.filter((c) => c.method === 'Motor/Ramp').map((c) => [c.instance, c.inputs]), [['Pump2', [1200, 'auto']]]);

    const fast = await propose('ramp_pump', pumps, 'Pump2', { rpm: 2000, mode: 'auto' });
    assert.deepEqual([fast.status, fast.refusedStage], ['refused', 'intent']);
    assert.match(fast.refusalReason!, /Rpm is outside the range its allow-list entry allows \(0 to 1500\)/);
    const turbo = await propose('ramp_pump', pumps, 'Pump2', { rpm: 100, mode: 'turbo' });
    assert.match(turbo.refusalReason ?? '', /Mode is not one of the values/);
    const fractional = await propose('ramp_pump', pumps, 'Pump2', { rpm: 12.5, mode: 'auto' });
    assert.deepEqual([fractional.status, fractional.refusedStage], ['refused', 'intent']);
    assert.match(fractional.refusalReason!, /Rpm is not an Int32/);
    const mismatched = await propose('ramp_pump', pumps, 'Pump1', { rpm: 100, mode: 'auto' });
    assert.deepEqual([mismatched.status, mismatched.refusedStage], ['refused', 'policy_gate']);
    assert.match(mismatched.refusalReason!, /not the ones its allow-list entry names \(Rpm\)/);
  });

  test('an OPC UA method call: resolved to its method, listed as one, previewed as a command, approved by two, verified by acknowledgement', async () => {
    const m = await propose('start_pump', pumps, 'Pump2');
    assert.equal(m.status, 'awaiting_approval', m.refusalReason ?? '');
    assert.equal(m.riskClass, 'physical');
    assert.ok(m.chain!.approvalsRequired >= 2);
    const physical = m.preview!.physical!;
    assert.equal(physical.statement, PHYSICAL_STATEMENT, 'reverted by its inverse: the statement no configuration removes');
    assert.deepEqual(physical.nodes.map((n) => [n.reference, n.command, n.nodeAddress, n.current, n.proposed, n.range, n.minIntervalSeconds, n.lastWrittenAt]),
      [['Pump2', 'start', method('Pump2', 'Start'), null, {}, null, 3_600, null]]);

    const done = await approved(m);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    startedPump2 = done.receiptId!;
    assert.equal(running['Pump2'], true);
    const receipt = await receiptOf(done.receiptId!);
    assert.equal(receipt.acknowledgement, COMMAND_ACKNOWLEDGEMENT, 'the receipt says acknowledgement does not confirm the physical outcome');
    assert.deepEqual(receipt.verifications.map((v) => [v.field, v.observed, v.outcome, v.reason]),
      [[null, { acknowledged: true, status: 'good' }, 'verified', 'acknowledged']]);
    const { rows } = await cell.migrate.query('select node_address, outcome, allowlist_entry_id from action.physical_writes where mutation_id = $1', [m.id]);
    assert.deepEqual(rows.map((r) => [r.node_address, r.outcome, r.allowlist_entry_id]), [[method('Pump2', 'Start'), 'applied', entries[method('Pump2', 'Start')]]]);
    assert.equal((await events('physical_action_executed')).at(-1)!.resource, m.id);
  });

  test('refused at intent: inside the entry\'s interval, a method not in the allow-list', async () => {
    const again = await propose('start_pump', pumps, 'Pump2');
    assert.deepEqual([again.status, again.refusedStage], ['refused', 'plan']);
    assert.match(again.refusalReason!, /less than 3600 seconds ago/);
    const unlisted = await propose('jog_pump', pumps, 'Pump1');
    assert.deepEqual([unlisted.status, unlisted.refusedStage], ['refused', 'policy_gate']);
    assert.match(unlisted.refusalReason!, /not in the connection's actuation allow-list/);
  });

  test('a command is reverted by its inverse, the one its allow-list entry names; a command whose entry names none is not', async () => {
    const revert = await gateway.call(requestRevert, { body: { receiptId: startedPump2, scope: 'full' } }, keyed(root));
    const m = await gateway.call(getMutation, { params: { mutationId: revert.newMutationId } }, cell.as(root));
    assert.deepEqual([m.status, m.origin, m.riskClass], ['awaiting_approval', 'revert', 'physical'], m.refusalReason ?? '');
    assert.ok(m.chain!.approvalsRequired >= 2, 'the same two-person approval');
    assert.deepEqual(m.preview!.physical!.nodes.map((n) => [n.command, n.nodeAddress]), [['stop', method('Pump2', 'Stop')]]);
    const reverted = await approved(m);
    assert.deepEqual([reverted.status, running['Pump2']], ['completed', false]);

    const pump1 = await approved(await propose('start_pump', pumps, 'Pump1'));
    assert.equal(pump1.status, 'completed', JSON.stringify(pump1));
    await assert.rejects(gateway.call(requestRevert, { body: { receiptId: pump1.receiptId!, scope: 'full' } }, keyed(root)), { code: 'revert.no_inverse' });
  });

  test('not reversible: the preview says so, a rejection by the control system is failed and never retried, and a revert is refused', async () => {
    const m = await propose('jog_pump', pumps, 'Pump2');
    assert.equal(m.status, 'awaiting_approval', m.refusalReason ?? '');
    assert.equal(m.preview!.physical!.statement, NOT_REVERTIBLE_STATEMENT);
    rejectJog = true;
    const rejected = await approved(m);
    rejectJog = false;
    assert.equal(rejected.status, 'failed');
    assert.equal((await events('physical_write_rejected_by_control_system')).at(-1)!.resource, m.id);
    const { rows } = await cell.migrate.query('select outcome from action.physical_writes where mutation_id = $1', [m.id]);
    assert.deepEqual(rows.map((r) => r.outcome), ['rejected'], 'once: never retried');

    const jogged = await approved(await propose('jog_pump', pumps, 'Pump2'));
    assert.equal(jogged.status, 'completed');
    await assert.rejects(gateway.call(requestRevert, { body: { receiptId: jogged.receiptId!, scope: 'full' } }, keyed(root)), { code: 'revert.not_revertible' });
  });

  test('an MQTT command: published to the topic its record names, with the payload its schema declares; off its schema or check, refused at intent', async () => {
    const m = await propose('run_line', lines, '4', { speed: 40 });
    assert.equal(m.status, 'awaiting_approval', m.refusalReason ?? '');
    const physical = m.preview!.physical!;
    assert.equal(physical.statement, NOT_REVERTIBLE_STATEMENT);
    assert.deepEqual(physical.nodes.map((n) => [n.reference, n.command, n.nodeAddress, n.payload]), [['4', 'run', topic('4'), '{"run":true,"speed":40}']]);
    const done = await approved(m);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.deepEqual(published.map((p) => [p.topic, p.payload, p.qos, p.retained, p.dryRun ?? false]), [[topic('4'), '{"run":true,"speed":40}', 1, false, false]]);
    assert.equal((await receiptOf(done.receiptId!)).acknowledgement, COMMAND_ACKNOWLEDGEMENT);

    const fractional = await propose('run_line', lines, '4', { speed: 2.5 });
    assert.deepEqual([fractional.status, fractional.refusedStage], ['refused', 'intent']);
    assert.match(fractional.refusalReason!, /speed is not an integer/);
    const checked = await propose('run_line', lines, '4', { speed: 150 });
    assert.match(checked.refusalReason ?? '', /value check refuses the inputs/);
    const unlisted = await propose('run_line', lines, '5', { speed: 10 });
    assert.deepEqual([unlisted.status, unlisted.refusedStage], ['refused', 'policy_gate']);
  });

  test('a dry run of a command publishes to the simulator topic its entry names (spec 47.5)', async () => {
    const m = await propose('run_line', lines, '4', { speed: 10 }, { dryRun: true });
    assert.equal(m.status, 'awaiting_approval', m.refusalReason ?? '');
    assert.equal(m.preview!.physical!.nodes[0]!.simulatorAddress, `sim/${topic('4')}`);
    const done = await approved(m);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.equal(published.at(-1)!.dryRun, true);
    const { rows } = await cell.migrate.query('select node_address, dry_run from action.physical_writes where mutation_id = $1', [m.id]);
    assert.deepEqual(rows.map((r) => [r.node_address, r.dry_run]), [[`sim/${topic('4')}`, true]]);
  });
});
