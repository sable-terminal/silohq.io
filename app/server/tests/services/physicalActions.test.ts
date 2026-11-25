// Physical Actions end to end in the cell (spec 47.2 to 47.6, 47.8): an Action setting a pump's
// speed over an OPC UA connection. At proposal the agent resolves each node and reads its value
// now; the node must be in the signed actuation allow-list, pass its writable point's value
// check, keep to the entry's range, step and interval and the connection's writes a minute
// (refused otherwise, the rate's refusal recorded); the preview shows the nodes and the
// statement no configuration removes. Two people approve, one holding actuation.approve; the
// write is logged node by node, physical_action_executed names both approvers, the entries and
// the receipt; a node the agent refused although the cell passed it raises
// physical_write_refused_by_agent. The agent is a fake over an in-memory plant here: its own
// checks run against the real agent in agentOpcua.test.ts. Real processes: credential, policy,
// auth, connect-registry, connect-runtime, ontology, approvals, actions.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { decideAllowlistRequest, requestAllowlistEntry } from '../../src/contracts/actions/allowlist.contract.ts';
import { proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
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
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { setPhysicalDryRun } from '../../src/contracts/actions/settings.contract.ts';
import { requestRevert } from '../../src/contracts/revert/revert.contract.ts';
import { service as revertService } from '../../src/routes/revert/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import type { AgentChannel, AgentPhysicalResult } from '../../src/services/connect-runtime/agent.service.ts';
import { PHYSICAL_STATEMENT } from '../../src/services/actions/physical.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';
import { freePort } from './writeback.helper.ts';

const PLANT = 'urn:silo:test:plant';
const node = (pump: string) => `nsu=${PLANT};s=${pump}.Motor.Speed`;

// The plant the fake agent reads and writes.
const speeds: Record<string, number> = { Pump1: 1450, Pump2: 0 };
// The simulator's counterparts (47.5): a dry run writes only these.
const simulated: Record<string, number> = {};
const entries: Record<string, string> = {};
let agentRefuses: string | undefined;

const agent: AgentChannel = {
  async query() { throw new Error('no SQL here'); },
  async opcua(input) {
    const rows = Object.entries(speeds).map(([pump, rpm]) => Object.fromEntries(input.paths.map((p) => [p,
      p === '$browseName' ? pump : p === '$nodeId' ? `nsu=${PLANT};s=${pump}` : p === 'Motor/Speed' ? rpm : p === 'Motor/Speed/$nodeId' ? node(pump) : null])));
    return { rows, truncated: false };
  },
  async opcuaWrite(input) {
    return input.statements.map((s): AgentPhysicalResult => {
      const nodes = s.writes.map((w) => ({ path: w.path, nodeAddress: node(s.instance), entryId: entries[s.instance] ?? '', status: '' }));
      if (agentRefuses !== undefined) return { key: s.key, outcome: 'refused', reason: agentRefuses, nodes };
      if (s.dryRun === true) {
        for (const w of s.writes) simulated[s.instance] = Number(w.value);
        return { key: s.key, outcome: 'applied', nodes: nodes.map((n) => ({ ...n, status: 'good', simulatorAddress: `nsu=${PLANT};s=Sim.${s.instance}.Motor.Speed`, observed: simulated[s.instance] })) };
      }
      for (const w of s.writes) speeds[s.instance] = Number(w.value);
      return { key: s.key, outcome: 'applied', nodes: nodes.map((n) => ({ ...n, status: 'good' })) };
    });
  },
};

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let ops: Signed;
let second: Signed;
let connectionId: string;
let actionTypeId: string;
let productionReceipt = '';

const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });

const manifest = () => doc({
  schemaVersion: '1', identity: { name: 'Pump house', provider: 'Example plant', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'opc_ua' }, auth: { strategy: 'none' },
  objects: [{
    name: 'pumps', identifier: ['id'],
    fields: [{ name: 'id', type: 'string', path: '$browseName' }, { name: 'rpm', type: 'integer', path: 'Motor/Speed' }],
    source: { kind: 'opc_ua', root: `nsu=${PLANT};s=Pumps` },
    writes: { update: {}, risk: 'physical', bounds: { maxRows: 10 } },
  }],
});

async function allowlisted(pump: string, extra: Record<string, unknown>): Promise<void> {
  // Declared once; listed again after a removal.
  await gateway.call(declareWritablePoint, {
    params: { connectionId }, body: { address: node(pump), valueCheck: { cel: 'values.rpm % 10 == 0' }, settleSeconds: 0, testSafe: false },
  }, cell.as(root)).catch((error: { code?: string }) => { if (error.code !== 'industrial.point_exists') throw error; });
  const asked = await gateway.call(requestAllowlistEntry, {
    params: { connectionId }, body: { nodeAddress: node(pump), kind: 'setpoint', dataType: 'Int32', objectId: uuidv7(), ...extra } as never,
  }, cell.as(root));
  const { entry } = await gateway.call(decideAllowlistRequest, { params: { requestId: asked.id }, body: { decision: 'approve' } }, cell.as(ops));
  entries[pump] = entry!.id;
}

const propose = (pump: string, rpm: number) => gateway.call(proposeMutation, {
  body: { actionTypeId, parameters: { rpm }, objects: [{ connectionId, reference: pump }] },
}, keyed(root));

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
  // Two approvers: one holds actuation.approve through the physical operations role (47.2).
  ops = await cell.member('ops@acme.example', 'Super admin');
  await gateway.call(grantRole, { body: { membershipId: ops.membershipId, roleId: cell.roles['Physical operations']! } }, cell.as(root));
  second = await cell.member('second@acme.example', 'Super admin');

  const poolId = (await gateway.call(createAgentPool, { body: { name: 'Pump house', environment: 'production' } }, cell.as(root))).id;
  const connector = await gateway.call(createConnector, { body: { slug: `pa-${uuidv7().slice(-12)}`, name: 'Pumps', provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest() } }, keyed(root));
  let connection = await gateway.call(createConnection, {
    body: { connectorId: connector.id, name: 'Pumps', owningScopeId: cell.scopes['engineering']!, agentPoolId: poolId },
  }, keyed(root));
  connectionId = connection.id;
  await gateway.call(createIndustrialEndpoint, {
    params: { connectionId }, body: { plugin: 'opcua', endpointUrl: 'opc.tcp://10.0.0.5:4840', securityPolicy: 'None', insecureException: true },
  }, cell.as(root));
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(connectionId);
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId }, body: { move, version: connection.version } }, cell.as(root));
  }
  await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    'update connect.connections set writes_enabled = true, max_physical_writes_per_minute = 2 where id = $1', [connectionId]));
  for (const who of [ops, second]) {
    await gateway.call(grantConnection, { body: { connectionId, grantee: { kind: 'membership', id: who.membershipId }, access: 'read' } }, cell.as(root));
  }
  await allowlisted('Pump1', { minValue: '0', maxValue: '1800', maxStep: '200', minIntervalSeconds: 3_600 });

  // The ontology: a Pump over the connection; an Action type setting its speed, physical.
  // Authored by one person, confirmed by another (the author does not approve their own proposal).
  const branch = await gateway.call(openBranch, { body: { name: 'pumps' } }, keyed(second));
  await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'pump' }, body: {
    displayName: 'Pump', pluralName: 'Pumps', contributingObjects: [{ connectionId, sourceObject: 'pumps', identifierFieldPath: 'id' }],
    properties: [
      { apiName: 'pump_name', displayName: 'Pump', dataType: 'string', nullable: false, mappings: [{ connectionId, sourceObject: 'pumps', fieldPath: 'id' }] },
      { apiName: 'rpm', displayName: 'Speed', dataType: 'integer', mappings: [{ connectionId, sourceObject: 'pumps', fieldPath: 'rpm' }] },
    ],
    primaryKey: 'pump_name', title: 'pump_name',
  } as never }, keyed(second));
  const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Pumps' } }, keyed(second));
  await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
  const merged = await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
  const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(`select id from ontology.object_types where organisation_id = $1 and api_name = 'pump'`, [cell.org]));
  const type = await gateway.call(proposeActionType, { body: { apiName: 'set_speed', displayName: 'Set speed', owningScopeId: cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: {
    ontologyVersionId: merged.version.id, objectTypeId: rows[0].id, properties: ['rpm'],
    parameters: [{ name: 'rpm', type: 'integer', required: true }], rules: [{ kind: 'set_property', property: 'rpm', value: { parameter: 'rpm' } }],
    permittedConnections: [connectionId], riskClass: 'physical',
  } as never }, keyed(root));
  actionTypeId = type.id;
});

after(async () => {
  await cell?.close();
});

describe('physical Actions (spec 47.2 to 47.6, 47.8)', () => {
  test('a setpoint: resolved and checked at intent, previewed with its node and the statement, approved by two, logged and named when executed', async () => {
    const m = await propose('Pump1', 1550);
    assert.equal(m.status, 'awaiting_approval', JSON.stringify(m));
    assert.equal(m.riskClass, 'physical');
    assert.ok(m.chain!.approvalsRequired >= 2);
    const physical = m.preview!.physical!;
    assert.equal(physical.statement, PHYSICAL_STATEMENT);
    assert.deepEqual(physical.nodes.map((n) => [n.reference, n.nodeAddress, n.current, n.proposed, n.range, n.maxStep, n.minIntervalSeconds, n.maxPerMinute, n.lastWrittenAt]),
      [['Pump1', node('Pump1'), 1450, 1550, { min: '0', max: '1800' }, '200', 3_600, 2, null]]);
    assert.equal((await events('physical_action_proposed'))[0]!.resource, m.id);

    const done = await approved(m);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    productionReceipt = done.receiptId!;
    assert.equal(speeds['Pump1'], 1550);
    const { rows } = await cell.migrate.query('select node_address, outcome, allowlist_entry_id from action.physical_writes where mutation_id = $1', [m.id]);
    assert.deepEqual(rows.map((r) => [r.node_address, r.outcome, r.allowlist_entry_id]), [[node('Pump1'), 'applied', entries['Pump1']]]);
    const [executed] = await events('physical_action_executed');
    assert.deepEqual([executed!.resource, executed!.detail['receipt_id'], [...(executed!.detail['approvers'] as string[])].sort(), executed!.detail['entries'], executed!.detail['node']],
      [m.id, done.receiptId, [ops.membershipId, second.membershipId].sort(), [entries['Pump1']], node('Pump1')]);
    const [approvedEvent] = await events('physical_action_approved');
    assert.deepEqual([approvedEvent!.resource, [...(approvedEvent!.detail['approvers'] as string[])].sort(), approvedEvent!.detail['dry_run']],
      [m.id, [ops.membershipId, second.membershipId].sort(), false], 'the chain complete, both approvers named (47.8)');
    const [verified] = await events('physical_action_verified');
    assert.deepEqual([verified!.resource, verified!.detail['receipt_id']], [m.id, done.receiptId], 'every node read back as written');
  });

  test('refused at intent: outside the range, too large a step, the value check, inside the interval, not in the allow-list', async () => {
    const refusal = async (pump: string, rpm: number) => {
      const m = await propose(pump, rpm);
      return [m.status, m.refusedStage, m.refusalReason ?? ''] as const;
    };
    const [status, stage, reason] = await refusal('Pump1', 1700);
    assert.deepEqual([status, stage], ['refused', 'plan']);
    assert.match(reason, /less than 3600 seconds ago/, 'the interval since the last write');
    // A fresh entry for Pump2 (no interval) shows the range, step and value check.
    await allowlisted('Pump2', { minValue: '0', maxValue: '1000', maxStep: '100', minIntervalSeconds: 0 });
    assert.deepEqual((await refusal('Pump2', 2000)).slice(0, 2), ['refused', 'intent']);
    assert.match((await refusal('Pump2', 2000))[2], /outside its allow-listed range/);
    assert.match((await refusal('Pump2', 500))[2], /a step of more than 100/);
    assert.match((await refusal('Pump2', 55))[2], /value check refuses/);
    await cell.migrate.query(`update action.actuation_allowlists set removed_at = now() where id = $1`, [entries['Pump2']]);
    assert.deepEqual((await refusal('Pump2', 50)).slice(0, 2), ['refused', 'policy_gate']);
  });

  test('the connection\'s writes a minute: beyond it refused, and recorded; the canary does not apply', async () => {
    await allowlisted('Pump2', { minValue: '0', maxValue: '1000', maxStep: '100', minIntervalSeconds: 0 });
    await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('update connect.connections set max_physical_writes_per_minute = 1 where id = $1', [connectionId]));
    const m = await propose('Pump2', 50);
    assert.deepEqual([m.status, m.refusedStage], ['refused', 'plan']);
    assert.match(m.refusalReason!, /at most 1 physical writes a minute/);
    const [rate] = await events('physical_rate_limit_refused');
    assert.deepEqual([rate!.resource, rate!.detail['limit'], rate!.detail['recent'], rate!.detail['planned']], [connectionId, 1, 1, 1]);
    await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('update connect.connections set max_physical_writes_per_minute = 10 where id = $1', [connectionId]));
  });

  test('a write the agent refuses although the cell passed it: failed, logged as refused, raised', async () => {
    const m = await propose('Pump2', 50);
    assert.equal(m.status, 'awaiting_approval', m.refusalReason ?? '');
    agentRefuses = 'not_listed';
    const done = await approved(m);
    agentRefuses = undefined;
    assert.equal(done.status, 'failed');
    assert.equal(speeds['Pump2'], 0, 'nothing written');
    const { rows } = await cell.migrate.query('select outcome, reason from action.physical_writes where mutation_id = $1', [m.id]);
    assert.deepEqual(rows.map((r) => [r.outcome, r.reason]), [['refused', 'not_listed']]);
    const [raised] = await events('physical_write_refused_by_agent');
    assert.deepEqual([raised!.resource, raised!.detail['reason']], [m.id, 'not_listed']);
  });

  test('a setpoint is reverted by writing its prior value: checked and previewed as any physical Action, approved by the same two (spec 47.6)', async () => {
    const done = await approved(await propose('Pump2', 50));
    assert.deepEqual([done.status, speeds['Pump2']], ['completed', 50]);
    const revert = await gateway.call(requestRevert, { body: { receiptId: done.receiptId!, scope: 'full' } }, keyed(root));
    const m = await gateway.call(getMutation, { params: { mutationId: revert.newMutationId } }, cell.as(root));
    assert.deepEqual([m.status, m.origin, m.riskClass], ['awaiting_approval', 'revert', 'physical']);
    assert.ok(m.chain!.approvalsRequired >= 2, 'the same two-person approval');
    assert.equal(m.preview!.physical!.statement, PHYSICAL_STATEMENT);
    assert.deepEqual(m.preview!.physical!.nodes.map((n) => [n.reference, n.current, n.proposed]), [['Pump2', 50, 0]], 'the stored prior value');
    const reverted = await approved(m);
    assert.deepEqual([reverted.status, speeds['Pump2']], ['completed', 0]);
    const physicalReverts = await events('physical_action_reverted');
    assert.deepEqual([physicalReverts.at(-1)!.detail['mutation_id'], physicalReverts.at(-1)!.detail['receipt_id']], [m.id, reverted.receiptId], 'physical_action_reverted (47.8)');
    const executed = await events('physical_action_executed');
    assert.equal(executed.at(-1)!.resource, m.id);
  });

  test('a dry run: the full path against the simulator nodes, nothing written to production, its receipt marked; a policy may require one first (spec 47.5)', async () => {
    const dryRun = (pump: string, rpm: number) => gateway.call(proposeMutation, {
      body: { actionTypeId, parameters: { rpm }, objects: [{ connectionId, reference: pump }], dryRun: true },
    }, keyed(root));
    const refused = await dryRun('Pump1', 1600);
    assert.deepEqual([refused.status, refused.refusedStage], ['refused', 'policy_gate']);
    assert.match(refused.refusalReason!, /no simulator node/);
    // Listed again with its simulator counterpart.
    await cell.migrate.query('update action.actuation_allowlists set removed_at = now() where id = $1', [entries['Pump1']]);
    const simulator = `nsu=${PLANT};s=Sim.Pump1.Motor.Speed`;
    await allowlisted('Pump1', { minValue: '0', maxValue: '1800', maxStep: '200', minIntervalSeconds: 3_600, simulatorAddress: simulator });
    // Inside production's interval since the first test's write: a dry run does not count against it.
    const m = await dryRun('Pump1', 1600);
    assert.equal(m.status, 'awaiting_approval', m.refusalReason ?? '');
    assert.equal(m.dryRun, true);
    assert.ok(m.chain!.approvalsRequired >= 2, 'the full path: two people approve a dry run too');
    assert.deepEqual([m.preview!.physical!.dryRun, m.preview!.physical!.nodes[0]!.simulatorAddress], [true, simulator]);
    const done = await approved(m);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.deepEqual([speeds['Pump1'], simulated['Pump1']], [1550, 1600], 'the simulator written and read back; production untouched');
    const { rows: [receipt] } = await cell.migrate.query('select dry_run from action.receipts where id = $1', [done.receiptId]);
    assert.equal(receipt!.dry_run, true);
    const { rows: writes } = await cell.migrate.query('select node_address, dry_run from action.physical_writes where mutation_id = $1', [m.id]);
    assert.deepEqual(writes.map((w) => [w.node_address, w.dry_run]), [[simulator, true]]);
    assert.equal((await events('physical_action_dry_run')).at(-1)!.resource, m.id);
    // It wrote nothing to production, so nothing of it is reverted there.
    await assert.rejects(gateway.call(requestRevert, { body: { receiptId: done.receiptId!, scope: 'full' } }, keyed(root)), { code: 'revert.dry_run' });

    // Required by the organisation: a physical proposal names a completed dry run of the Action type.
    await gateway.call(setPhysicalDryRun, { body: { required: true } }, cell.as(root));
    const unnamed = await propose('Pump2', 50);
    assert.deepEqual([unnamed.status, unnamed.refusedStage], ['refused', 'intent']);
    assert.match(unnamed.refusalReason!, /requires a dry run/);
    const production = await gateway.call(proposeMutation, {
      body: { actionTypeId, parameters: { rpm: 50 }, objects: [{ connectionId, reference: 'Pump2' }], dryRunReceiptId: productionReceipt },
    }, keyed(root));
    assert.match(production.refusalReason ?? '', /not a dry run/, 'a production receipt is not a dry run');
    const named = await gateway.call(proposeMutation, {
      body: { actionTypeId, parameters: { rpm: 50 }, objects: [{ connectionId, reference: 'Pump2' }], dryRunReceiptId: done.receiptId! },
    }, keyed(root));
    assert.deepEqual([named.status, named.dryRunReceiptId], ['awaiting_approval', done.receiptId]);
    await gateway.call(setPhysicalDryRun, { body: { required: false } }, cell.as(root));
  });
});
