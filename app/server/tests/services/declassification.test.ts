// Declassification end to end (spec 58.9): requested by a holder of marking.declassify who
// satisfies the marking, previewed (members gaining access, artefacts losing it downstream),
// approved through approvals by another person who satisfies it (never the requester, never
// a service principal), executed by policy, and reverted. Downstream, an artefact keeps the
// marking while another input still carries it.
//
// Real processes: credential, policy, auth, connect-registry and approvals. Lineage is laid
// down directly: two connections marked Secret, a view fed by the first, and a view fed by
// both.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { createConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import {
  getDeclassification, listDeclassifications, requestDeclassification, revertDeclassification,
} from '../../src/contracts/policy/declassification.contract.ts';
import {
  applyMarking, approveDeclassifier, createMarking, grantClearance, grantDeclassifier, listResourceMarkings, revokeDeclassifier,
} from '../../src/contracts/policy/governance.contract.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let root: Signed;
let approver: Signed;
let uncleared: Signed;
let secret: string;
const connections: string[] = [];
const nodes: Record<string, string> = {};

const gateway = () => cell.client('gateway');
const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });
const policyEvents = async (event: string) => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by created_at, id`,
  [cell.org, event]))).rows.map((r) => r.payload);
const liveInherited = async () => (await cell.migrate.query(
  `select lineage_node_id from gov.artefact_markings where organisation_id = $1 and marking_id = $2 and origin = 'inherited' and removed_at is null`,
  [cell.org, secret])).rows.map((r) => r.lineage_node_id as string).sort();

before(async () => {
  cell = await createConnectCell();
  await cell.start(approvalsService, 'approvals', 'test_app');
  root = await cell.signIn('root@acme.example');
  approver = await cell.member('approver@acme.example', 'Super admin');
  uncleared = await cell.member('uncleared@acme.example', 'Super admin');
  secret = (await gateway().call(createMarking, { body: { name: 'Secret', kind: 'classification', description: 'Need to know' } }, cell.as(root))).id;
  for (const who of [root, approver]) {
    await gateway().call(grantClearance, { body: { markingId: secret, holder: { kind: 'membership', id: who.membershipId } } }, cell.as(root));
  }
  for (const name of ['ledger', 'archive']) {
    const connector = await gateway().call(createConnector, { body: { slug: `c-${uuidv7().slice(-12)}`, name, provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
    await gateway().call(createManifestVersion, {
      params: { connectorId: connector.id },
      body: {
        document: doc({
          schemaVersion: '1', identity: { name, provider: 'Example', version: '1.0.0' }, transport: { viaAgent: false, baseUrl: 'http://127.0.0.1:9' },
          protocol: { kind: 'rest' }, auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
          objects: [{
            name: 'entries', identifier: ['id'], fields: [{ name: 'id', type: 'string', nullable: false }],
            source: { kind: 'rest', request: { method: 'GET', path: '/v1/entries', query: {} }, records: { jsonata: 'results' } },
          }],
        }),
      },
    }, keyed(root));
    const connection = await gateway().call(createConnection, { body: { connectorId: connector.id, name, owningScopeId: cell.scopes['engineering']! } }, keyed(root));
    connections.push(connection.id);
    await gateway().call(applyMarking, { body: { markingId: secret, resource: { type: 'connection', id: connection.id } } }, cell.as(root));
  }
  // Lineage: ledger -> v1; ledger -> v2 <- archive. Each view inherited Secret when it was produced.
  const node = async (name: string, kind: string, refId: string) => {
    nodes[name] = uuidv7();
    await cell.migrate.query(`insert into gov.lineage_nodes (id, organisation_id, kind, ref_id, version) values ($1, $2, $3, $4, '1')`,
      [nodes[name], cell.org, kind, refId]);
  };
  await node('ledger', 'connection', connections[0]!);
  await node('archive', 'connection', connections[1]!);
  await node('v1', 'view', uuidv7());
  await node('v2', 'view', uuidv7());
  for (const [from, to] of [['ledger', 'v1'], ['ledger', 'v2'], ['archive', 'v2']] as const) {
    await cell.migrate.query(`insert into gov.lineage_edges (organisation_id, from_node_id, to_node_id, relation) values ($1, $2, $3, 'derives')`,
      [cell.org, nodes[from], nodes[to]]);
  }
  for (const [view, from] of [['v1', 'ledger'], ['v2', 'ledger']] as const) {
    await cell.migrate.query(`insert into gov.artefact_markings (id, organisation_id, lineage_node_id, marking_id, origin, inherited_from_node_id)
      values ($1, $2, $3, $4, 'inherited', $5)`, [uuidv7(), cell.org, nodes[view], secret, nodes[from]]);
  }
});

after(async () => {
  await cell?.close();
});

describe('declassification (spec 58.9)', () => {
  let id: string;

  test('requesting needs marking.declassify and the marking; the preview counts who gains access and what loses it downstream', async () => {
    await assert.rejects(gateway().call(requestDeclassification, {
      body: { markingId: secret, resource: { type: 'connection', id: connections[0]! }, justification: 'released' },
    }, cell.as(uncleared)), { code: 'declassification.marking_unsatisfied' });
    const requested = await gateway().call(requestDeclassification, {
      body: { markingId: secret, resource: { type: 'connection', id: connections[0]! }, justification: 'released under FOI 2026/114', applyDownstream: true },
    }, cell.as(root));
    id = requested.id;
    assert.equal(requested.status, 'awaiting_approval');
    assert.deepEqual([requested.preview.markingsBefore, requested.preview.markingsAfter], [[secret], []]);
    assert.equal(requested.preview.readersGainingAccess, 1, 'the one active member without the clearance');
    assert.equal(requested.preview.downstreamLosing, 1, 'v1 only inherits it from the ledger; v2 still has the archive');
    assert.deepEqual((await gateway().call(listResourceMarkings, { query: { type: 'connection', id: connections[0]! } }, cell.as(root))).markingIds, [secret],
      'nothing changes before approval');
    assert.equal((await policyEvents('marking_declassification_requested')).length, 1);
  });

  test('the requester cannot approve, nor can someone who does not satisfy the marking; another who does, approves, and it executes', async () => {
    const view = await gateway().call(getDeclassification, { params: { declassificationId: id } }, cell.as(approver));
    const decide = (who: Signed) => gateway().call(decideApproval, {
      params: { chainId: view.approvalChainId }, body: { decision: 'approved', diffHash: view.diffHash },
    }, cell.as(who));
    await assert.rejects(decide(root), (e: { category?: string }) => e.category === 'forbidden');
    await assert.rejects(decide(uncleared), (e: { category?: string }) => e.category === 'forbidden');
    const chain = await decide(approver);
    assert.equal(chain.status, 'approved');
    const executed = await gateway().call(getDeclassification, { params: { declassificationId: id } }, cell.as(root));
    assert.equal(executed.status, 'executed');
    assert.deepEqual((await gateway().call(listResourceMarkings, { query: { type: 'connection', id: connections[0]! } }, cell.as(root))).markingIds, []);
    assert.deepEqual(await liveInherited(), [nodes['v2']], 'v1 loses it; v2 keeps it through the archive');
    assert.equal((await policyEvents('marking_declassified')).length, 1);
  });

  test('reverting puts back exactly what was removed', async () => {
    const reverted = await gateway().call(revertDeclassification, { params: { declassificationId: id } }, cell.as(root));
    assert.equal(reverted.status, 'reverted');
    assert.deepEqual((await gateway().call(listResourceMarkings, { query: { type: 'connection', id: connections[0]! } }, cell.as(root))).markingIds, [secret]);
    assert.deepEqual(await liveInherited(), [nodes['v1'], nodes['v2']].sort());
    assert.equal((await policyEvents('marking_declassification_reverted')).length, 1);
    const listed = await gateway().call(listDeclassifications, { query: {} }, cell.as(root));
    assert.deepEqual(listed.declassifications.map((d) => d.status), ['reverted']);
  });

  test('a membership named for the marking requests it, once a second person approves the naming (58.10; decision 2026-11-14)', async () => {
    const named = await cell.member('named@acme.example', 'Admin');
    await gateway().call(grantClearance, { body: { markingId: secret, holder: { kind: 'membership', id: named.membershipId } } }, cell.as(root));
    const ask = () => gateway().call(requestDeclassification, {
      body: { markingId: secret, resource: { type: 'connection', id: connections[1]! }, justification: 'named declassifier' },
    }, cell.as(named));
    await assert.rejects(ask(), { code: 'declassification.not_granted' });
    const grant = await gateway().call(grantDeclassifier, {
      body: { markingId: secret, grantee: { kind: 'membership', id: named.membershipId }, justification: 'records officer for Secret' },
    }, cell.as(root));
    assert.equal(grant.status, 'awaiting_approval');
    await assert.rejects(ask(), { code: 'declassification.not_granted' }, 'not before approval');
    await assert.rejects(gateway().call(approveDeclassifier, { params: { declassifierId: grant.id } }, cell.as(root)), { code: 'declassifier.self_approval' });
    assert.equal((await gateway().call(approveDeclassifier, { params: { declassifierId: grant.id } }, cell.as(approver))).status, 'active');
    assert.equal((await ask()).status, 'awaiting_approval');
    await gateway().call(revokeDeclassifier, { params: { declassifierId: grant.id } }, cell.as(approver));
    await assert.rejects(ask(), { code: 'declassification.not_granted' });
  });

  test('a resource that does not carry the marking directly is refused', async () => {
    const other = await gateway().call(createMarking, { body: { name: 'Internal', kind: 'classification', description: 'Staff only' } }, cell.as(root));
    await gateway().call(grantClearance, { body: { markingId: other.id, holder: { kind: 'membership', id: root.membershipId } } }, cell.as(root));
    await assert.rejects(gateway().call(requestDeclassification, {
      body: { markingId: other.id, resource: { type: 'connection', id: connections[1]! }, justification: 'tidy' },
    }, cell.as(root)), { code: 'declassification.not_marked' });
  });
});
