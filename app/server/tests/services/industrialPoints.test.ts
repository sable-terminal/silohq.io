// Writable points (spec 20.3, 20.5, 20.7): declared by a connection owner holding
// industrial.declare_writable, against the manifest version the connection runs; the address
// the transport's, the value check required and compiled, the risk class never below the
// transport's (every MQTT write is physical), raised but never lowered, retired never deleted.
// Real processes: credential, policy, auth, connect-registry.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createAgentPool } from '../../src/contracts/connect-registry/agent.contract.ts';
import { createConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import {
  declareWritablePoint, listWritablePoints, raiseWritablePointRisk, retireWritablePoint, setWritablePointTestSafe,
} from '../../src/contracts/connect-registry/writablePoint.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let member: Signed;
let poolId: string;

const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });

async function connection(document: Record<string, never>, pooled: boolean): Promise<string> {
  const connector = await gateway.call(createConnector, { body: { slug: `wp-${uuidv7().slice(-12)}`, name: 'Plant', provider: 'Example', sourceRoute: 'visual' } }, keyed());
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } }, keyed());
  return (await gateway.call(createConnection, {
    body: { connectorId: connector.id, name: 'Plant', owningScopeId: cell.scopes['engineering']!, ...(pooled ? { agentPoolId: poolId } : {}) },
  }, keyed())).id;
}

const mqttManifest = () => doc({
  schemaVersion: '1', identity: { name: 'Line telemetry', provider: 'Example plant', version: '1.0.0' },
  transport: { viaAgent: true }, protocol: { kind: 'mqtt' }, auth: { strategy: 'none' },
  objects: [{
    name: 'readings', identifier: ['id'], fields: [{ name: 'id', type: 'string' }],
    source: { kind: 'mqtt', topic: 'site/+/temp', decode: { jsonata: '{ "id": topic[1] }' } },
  }],
});

const restManifest = () => doc({
  schemaVersion: '1', identity: { name: 'Valve service', provider: 'Example plant', version: '1.0.0' },
  transport: { viaAgent: false, baseUrl: 'https://plant.example' }, protocol: { kind: 'rest' }, auth: { strategy: 'none' },
  objects: [{
    name: 'valves', identifier: ['id'], fields: [{ name: 'id', type: 'string' }],
    source: { kind: 'rest', request: { method: 'GET', path: '/valves' }, records: { jsonata: 'items' } },
  }],
});

before(async () => {
  cell = await createConnectCell();
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  member = await cell.member('member@acme.example', 'Member');
  poolId = (await gateway.call(createAgentPool, { body: { name: 'Plant', environment: 'production' } }, cell.as(root))).id;
});

after(async () => {
  await cell?.close();
});

describe('writable points (spec 20.3, 20.5, 20.7)', () => {
  test('an MQTT point is a topic, physical whatever is asked, with a value check that compiles; nobody without the permission declares one', async () => {
    const id = await connection(mqttManifest(), true);
    const declare = (body: Record<string, unknown>, who = root) =>
      gateway.call(declareWritablePoint, { params: { connectionId: id }, body: body as never }, cell.as(who));
    const check = { cel: 'values.setpoint >= 0.0 && values.setpoint <= 90.0' };
    await assert.rejects(declare({ address: 'site/1/setpoint', valueCheck: check }, member), { code: 'connect.not_permitted' });
    await assert.rejects(declare({ address: 'site/+/setpoint', valueCheck: check }), { code: 'industrial.address_invalid' }, 'no wildcard');
    await assert.rejects(declare({ address: 'site/1/setpoint', valueCheck: check, riskClass: 'standard' }), { code: 'industrial.risk_below_transport' });
    await assert.rejects(declare({ address: 'site/1/setpoint', valueCheck: { cel: 'values.setpoint >=' } }), { code: 'industrial.value_check_invalid' });
    const point = await declare({ address: 'site/1/setpoint', valueCheck: check, feedbackAddress: 'site/1/temp', settleSeconds: 30, testSafe: true });
    assert.deepEqual([point.riskClass, point.feedbackAddress, point.settleSeconds, point.testSafe, point.declaredBy],
      ['physical', 'site/1/temp', 30, true, root.membershipId]);
    await assert.rejects(declare({ address: 'site/1/setpoint', valueCheck: check }), { code: 'industrial.point_exists' });
    const { rows } = await cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'writable_point_declared'`, [cell.org]);
    assert.deepEqual([rows.at(-1).detail.point_id, rows.at(-1).detail.risk_class], [point.id, 'physical']);
  });

  test('a webhook point is an action, standard by default and raised to physical once; test safety set; retired, never deleted', async () => {
    const id = await connection(restManifest(), false);
    await assert.rejects(gateway.call(declareWritablePoint, { params: { connectionId: id }, body: { address: 'Open Valve', valueCheck: { cel: 'true' } } }, cell.as(root)),
      { code: 'industrial.address_invalid' });
    const point = await gateway.call(declareWritablePoint, { params: { connectionId: id }, body: { address: 'open_valve', valueCheck: { cel: 'true' } } }, cell.as(root));
    assert.equal(point.riskClass, 'standard');
    const raised = await gateway.call(raiseWritablePointRisk, { params: { pointId: point.id }, body: { riskClass: 'physical' } }, cell.as(root));
    assert.equal(raised.riskClass, 'physical');
    const again = await gateway.call(raiseWritablePointRisk, { params: { pointId: point.id }, body: { riskClass: 'physical' } }, cell.as(root));
    assert.equal(again.riskClass, 'physical', 'raising a physical point changes nothing');
    await assert.rejects(cell.migrate.query(`update connect.writable_points set risk_class = 'standard' where id = $1`, [point.id]), /only be raised/);
    assert.equal((await gateway.call(setWritablePointTestSafe, { params: { pointId: point.id }, body: { testSafe: true } }, cell.as(root))).testSafe, true);
    const retired = await gateway.call(retireWritablePoint, { params: { pointId: point.id } }, cell.as(root));
    assert.ok(retired.retiredAt !== null);
    await assert.rejects(gateway.call(setWritablePointTestSafe, { params: { pointId: point.id }, body: { testSafe: false } }, cell.as(root)), { code: 'industrial.point_retired' });
    assert.deepEqual((await gateway.call(listWritablePoints, { params: { connectionId: id }, query: {} }, cell.as(root))).points, []);
    assert.equal((await gateway.call(listWritablePoints, { params: { connectionId: id }, query: { includeRetired: 'true' } }, cell.as(root))).points.length, 1);
    const { rows } = await cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'writable_point_risk_raised'`, [cell.org]);
    assert.deepEqual(rows.map((r) => [r.detail.from, r.detail.to]), [['standard', 'physical']]);
  });
});
