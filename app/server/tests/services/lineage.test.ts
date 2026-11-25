// Lineage end to end (spec 59, 58.6, 58.7): the writer records an artefact's node, input
// edges and inherited markings in the producer's transaction; policy's mandatory gate sees
// an artefact's inherited markings; a marking added upstream is evaluated at read time until
// the lineage service's walk stores it downstream; and the reader's and reviewer's queries,
// bounded, never show what the reader's markings withhold.
// Real processes: credential, policy, auth, connect-registry and lineage.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import type { LineageWriteInput, NodeRef } from '../../src/contracts/lineage/lineage.contract.ts';
import {
  accessOverlay, explainMarkings, getLineage, queryDownstream, queryUpstream,
} from '../../src/contracts/lineage/lineage.contract.ts';
import { authorise } from '../../src/contracts/policy/decision.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createLineageService } from '../../src/routes/lineage/index.route.ts';
import { markingsOfNodes } from '../../src/services/lineage/markings.service.ts';
import { reportLineageWriteFailure, writeLineage } from '../../src/services/lineage/writer.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let reviewer: Signed;
let cleared: Signed;
let member: Signed;
let hr: string;
let falcon: string;
const types: Record<string, string> = {};

const node = (kind: NodeRef['kind'], refId: string, version = '1'): NodeRef => ({ kind, refId, version });

/** Writes lineage as a producer would: in its own transaction, as the application role. */
const write = (input: LineageWriteInput) => inTx(cell.app, { orgId: cell.org }, () =>
  writeLineage(cell.app, { organisationId: cell.org, createdBy: { membershipId: root.membershipId } }, input));

const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  inTx(cell.app, { orgId: cell.org }, async () => (await cell.app.query(text, params)).rows as T[]);

async function objectType(apiName: string): Promise<string> {
  const id = uuidv7();
  await cell.migrate.query(
    `insert into ontology.object_types (id, organisation_id, api_name, created_by_membership_id) values ($1, $2, $3, $4)`,
    [id, cell.org, apiName, root.membershipId]);
  types[apiName] = id;
  return id;
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const decide = (who: Signed, resource: { type: 'view' | 'app'; id: string }) =>
  // lineage.view: a permission members and reviewers both hold, so only the markings decide.
  cell.client('workspace').call(authorise, { body: { permission: 'lineage.view', resource } }, cell.as(who));

const events = async (name: string) => (await sql<{ payload: { detail: Record<string, unknown>; resource: { type: string; id: string } } }>(
  `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by seq`,
  [cell.org, name])).map((r) => r.payload);

before(async () => {
  cell = await createConnectCell();
  await cell.start(createLineageService({ propagation: { intervalMs: 100, graceMs: 300, batch: 2 } }), 'lineage', 'test_app');
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  reviewer = await cell.member('reviewer@acme.example', 'Security reviewer');
  cleared = await cell.member('cleared@acme.example', 'Security reviewer');
  member = await cell.member('member@acme.example', 'Member');
  hr = (await gateway.call(createMarking, { body: { name: 'HR confidential', kind: 'compartment' } }, cell.as(root))).id;
  falcon = (await gateway.call(createMarking, { body: { name: 'Programme Falcon', kind: 'compartment' } }, cell.as(root))).id;
  for (const marking of [hr, falcon]) {
    await gateway.call(grantClearance, { body: { markingId: marking, holder: { kind: 'membership', id: cleared.membershipId } } }, cell.as(root));
  }
  for (const name of ['company', 'employee', 'project']) await objectType(name);
  await gateway.call(applyMarking, { body: { markingId: hr, resource: { type: 'object_type', id: types['employee']! } } }, cell.as(root));
});

after(async () => {
  await cell?.close();
});

describe('the writer (spec 59.2, 59.3)', () => {
  test('an artefact\'s node, its input nodes and the edges from each input, once however often it is written', async () => {
    const view = uuidv7();
    const connection = uuidv7();
    const input: LineageWriteInput = {
      artefact: node('view', view, 'hash-1'),
      inputs: [
        { node: node('object_type_version', types['company']!, 'v1'), relation: 'uses' },
        { node: node('source_field', uuidv7(), 'm1'), relation: 'read_via' },
        { node: node('connection', connection, 'm1'), relation: 'read_via' },
      ],
    };
    const first = await write(input);
    const again = await write(input);
    assert.equal(again.nodeId, first.nodeId);
    assert.deepEqual(first.markingIds, []);
    const edges = await sql<{ n: number }>('select count(*)::int as n from gov.lineage_edges where to_node_id = $1', [first.nodeId]);
    assert.equal(edges[0]!.n, 3, 'edges are not recorded twice');
    const nodes = await sql<{ n: number }>('select count(*)::int as n from gov.lineage_nodes where organisation_id = $1', [cell.org]);
    assert.equal(nodes[0]!.n, 4);
  });

  test('a changed artefact is a new version node; the old one and its edges remain', async () => {
    const view = uuidv7();
    const one = await write({ artefact: node('view', view, 'a'), inputs: [{ node: node('object_type_version', types['company']!, 'v1'), relation: 'uses' }] });
    const two = await write({ artefact: node('view', view, 'b'), inputs: [{ node: node('object_type_version', types['company']!, 'v2'), relation: 'uses' }] });
    assert.notEqual(one.nodeId, two.nodeId);
    const kept = await sql<{ n: number }>('select count(*)::int as n from gov.lineage_edges where to_node_id = $1', [one.nodeId]);
    assert.equal(kept[0]!.n, 1);
  });

  test('a write that does not match its contract, or that the database refuses, aborts and is audited', async () => {
    await assert.rejects(write({ artefact: node('view', uuidv7()), inputs: [{ node: node('view', uuidv7()), relation: 'teleports' as never }] }),
      { code: 'lineage.write_invalid' });
    const view = uuidv7();
    // A marking that does not exist: the foreign key refuses, and nothing of the artefact remains.
    await assert.rejects(write({ artefact: node('view', view), inputs: [], directMarkings: [uuidv7()] }), { code: 'lineage.write_failed' });
    assert.equal((await sql('select 1 from gov.lineage_nodes where ref_id = $1', [view])).length, 0, 'the transaction aborted with it');
    const pool = new pg.Pool({ connectionString: cell.h.url('test_app') });
    try {
      await reportLineageWriteFailure(pool, { organisationId: cell.org, createdBy: { membershipId: root.membershipId } }, node('view', view),
        uuidv7(), 'workspace');
    } finally {
      await pool.end();
    }
    const failed = await events('lineage_write_failed');
    assert.equal(failed.at(-1)!.resource.id, view);
    assert.equal(failed.at(-1)!.detail['producer'], 'workspace');
  });
});

describe('inherited markings (spec 58.1, 58.6, 58.7)', () => {
  let view: string;
  let app: string;

  test('an artefact carries the union of its inputs\' markings, stored with the input it came from', async () => {
    view = uuidv7();
    const written = await write({
      artefact: node('view', view, 'h'),
      inputs: [
        { node: node('object_type_version', types['employee']!, 'v1'), relation: 'uses' },
        { node: node('object_type_version', types['company']!, 'v1'), relation: 'uses' },
      ],
      directMarkings: [falcon],
    });
    assert.deepEqual(written.markingIds, [hr, falcon].sort());
    const stored = await sql<{ marking_id: string; origin: string; inherited_from_node_id: string | null }>(
      'select marking_id, origin, inherited_from_node_id from gov.artefact_markings where lineage_node_id = $1 order by origin', [written.nodeId]);
    assert.deepEqual(stored.map((r) => [r.marking_id, r.origin]), [[falcon, 'direct'], [hr, 'inherited']]);
    const employeeNode = await sql<{ id: string }>(`select id from gov.lineage_nodes where kind = 'object_type_version' and ref_id = $1`, [types['employee']]);
    assert.equal(stored.find((r) => r.origin === 'inherited')!.inherited_from_node_id, employeeNode[0]!.id);
  });

  test('and passes them on: an app built on the view inherits from the view', async () => {
    app = uuidv7();
    const written = await write({ artefact: node('app_version', app, 'v1'), inputs: [{ node: node('view', view, 'h'), relation: 'uses' }] });
    assert.deepEqual(written.markingIds, [hr, falcon].sort());
  });

  test('policy\'s mandatory gate sees an artefact\'s inherited markings (spec 58.1)', async () => {
    assert.deepEqual(await decide(member, { type: 'view', id: view }), { decision: 'deny', reason: 'marking_unsatisfied' });
    assert.deepEqual(await decide(member, { type: 'app', id: app }), { decision: 'deny', reason: 'marking_unsatisfied' });
    assert.deepEqual(await decide(cleared, { type: 'app', id: app }), { decision: 'allow', reason: 'allowed' });
    assert.deepEqual(await decide(member, { type: 'view', id: uuidv7() }), { decision: 'allow', reason: 'allowed' }, 'no lineage, no inherited markings');
  });
});

describe('a marking added upstream (spec 58.6)', () => {
  let view: string;
  let app: string;
  let projectNode: string;

  test('is evaluated at read time at once, then stored downstream by the walk, nearest first', async () => {
    view = uuidv7();
    app = uuidv7();
    const v = await write({ artefact: node('view', view), inputs: [{ node: node('object_type_version', types['project']!, 'v1'), relation: 'uses' }] });
    const a = await write({ artefact: node('app_version', app), inputs: [{ node: node('view', view), relation: 'uses' }] });
    projectNode = (await sql<{ id: string }>(`select id from gov.lineage_nodes where kind = 'object_type_version' and ref_id = $1`, [types['project']]))[0]!.id;
    assert.deepEqual(await decide(member, { type: 'app', id: app }), { decision: 'allow', reason: 'allowed' });

    await gateway.call(applyMarking, { body: { markingId: falcon, resource: { type: 'object_type', id: types['project']! } } }, cell.as(root));
    // No window: denied from the moment the marking is applied, walk or no walk.
    assert.deepEqual(await decide(member, { type: 'app', id: app }), { decision: 'deny', reason: 'marking_unsatisfied' });

    const done = await until('the propagation to complete', async () => {
      const rows = await sql<{ completed_at: string | null; nodes_marked: number }>(
        'select completed_at, nodes_marked from gov.marking_propagations where source_ref_id = $1', [types['project']]);
      return rows[0]?.completed_at ? rows[0] : undefined;
    });
    assert.equal(done.nodes_marked, 2);
    const stored = await sql<{ lineage_node_id: string; inherited_from_node_id: string }>(
      'select lineage_node_id, inherited_from_node_id from gov.artefact_markings where marking_id = $1 and lineage_node_id = any($2::uuid[])',
      [falcon, [v.nodeId, a.nodeId]]);
    assert.equal(stored.find((r) => r.lineage_node_id === v.nodeId)!.inherited_from_node_id, projectNode);
    assert.equal(stored.find((r) => r.lineage_node_id === a.nodeId)!.inherited_from_node_id, v.nodeId, 'each from its nearest upstream node');
    assert.deepEqual(await decide(member, { type: 'app', id: app }), { decision: 'deny', reason: 'marking_unsatisfied' });
    const propagated = await events('marking_propagated');
    assert.equal(propagated.at(-1)!.resource.id, falcon);
    assert.equal(propagated.at(-1)!.detail['nodes_marked'], 2);
  });

  test('a propagation that cannot complete stays pending, and is still evaluated at read time', async () => {
    const view2 = uuidv7();
    const company = types['company']!;
    const w = await write({ artefact: node('view', view2), inputs: [{ node: node('object_type_version', company, 'v1'), relation: 'uses' }] });
    // As a walk cut short by its depth bound leaves it: pending, and not in the worker's queue.
    await cell.migrate.query(
      `insert into gov.marking_propagations (id, organisation_id, marking_id, source_kind, source_ref_id, first_pass_at, refused_reason)
       values ($1, $2, $3, 'object_type_version', $4, now(), 'depth_bound')`, [uuidv7(), cell.org, hr, company]);
    const carried = await inTx(cell.app, { orgId: cell.org }, () => markingsOfNodes(cell.app, cell.org, [w.nodeId]));
    assert.deepEqual(carried.map((m) => [m.markingId, m.origin]), [[hr, 'pending']]);
    assert.deepEqual(await decide(member, { type: 'view', id: view2 }), { decision: 'deny', reason: 'marking_unsatisfied' });
    await cell.migrate.query('update gov.marking_propagations set completed_at = now() where source_ref_id = $1 and marking_id = $2', [company, hr]);
  });
});

describe('reading lineage (spec 59.4, 59.5)', () => {
  let connection: string;
  let fieldNode: NodeRef;
  let open: string;
  let restricted: string;
  let dashboard: string;

  before(async () => {
    connection = uuidv7();
    fieldNode = node('source_field', uuidv7(), 'm1');
    open = uuidv7();
    restricted = uuidv7();
    dashboard = uuidv7();
    const conn = node('connection', connection, 'm1');
    await write({ artefact: node('view', open), inputs: [{ node: fieldNode, relation: 'read_via' }, { node: conn, relation: 'read_via' }] });
    await write({ artefact: node('view', restricted), inputs: [{ node: conn, relation: 'read_via' },
      { node: node('object_type_version', types['employee']!, 'v1'), relation: 'uses' }] });
    await write({ artefact: node('app_version', dashboard), inputs: [{ node: node('view', open), relation: 'uses' }] });
  });

  test('lineage.view: the upstream of an artefact the reader can see, with depth from it', async () => {
    const graph = await gateway.call(getLineage, { query: { kind: 'app_version', refId: dashboard } }, cell.as(member));
    assert.equal(graph.direction, 'upstream');
    assert.deepEqual(graph.nodes.map((n) => `${n.depth}:${n.kind}`).sort(), ['0:app_version', '1:view', '2:connection', '2:source_field']);
    assert.equal(graph.edges.length, 3);
    assert.ok(graph.edges.every((e) => graph.nodes.some((n) => n.id === e.from) && graph.nodes.some((n) => n.id === e.to)));
    assert.equal(graph.withheld, 0);
    assert.equal((await events('lineage_opened')).length > 0, true);
  });

  test('an artefact the reader\'s markings withhold has no lineage for them', async () => {
    await assert.rejects(gateway.call(getLineage, { query: { kind: 'view', refId: restricted } }, cell.as(member)), { code: 'lineage.node_not_found' });
    const seen = await gateway.call(getLineage, { query: { kind: 'view', refId: restricted } }, cell.as(cleared));
    assert.ok(seen.nodes.some((n) => n.kind === 'object_type_version'));
  });

  test('lineage.read: downstream of a resource, withholding what the reviewer\'s markings do not reach', async () => {
    const withoutClearance = await gateway.call(queryDownstream, { query: { kind: 'connection', refId: connection } }, cell.as(reviewer));
    assert.deepEqual(withoutClearance.nodes.map((n) => n.kind).sort(), ['app_version', 'connection', 'view']);
    assert.equal(withoutClearance.withheld, 1, 'the restricted view: counted, never named');
    assert.ok(!withoutClearance.nodes.some((n) => n.refId === restricted));
    const withClearance = await gateway.call(queryDownstream, { query: { kind: 'connection', refId: connection } }, cell.as(cleared));
    assert.equal(withClearance.nodes.length, 4);
    assert.equal(withClearance.withheld, 0);
    const queried = await events('lineage_queried');
    assert.equal(queried.at(-1)!.detail['query'], 'downstream');
  });

  test('lineage.read is the reviewer\'s; a member is refused', async () => {
    await assert.rejects(gateway.call(queryUpstream, { query: { kind: 'app_version', refId: dashboard } }, cell.as(member)), { code: 'lineage.not_permitted' });
    const up = await gateway.call(queryUpstream, { query: { kind: 'app_version', refId: dashboard } }, cell.as(reviewer));
    assert.equal(up.nodes.length, 4);
  });

  test('bounded: more nodes or more depth than allowed is refused with the bound named, never truncated', async () => {
    await assert.rejects(gateway.call(queryUpstream, { query: { kind: 'app_version', refId: dashboard, maxNodes: 2 } }, cell.as(reviewer)),
      { category: 'bounds', code: 'lineage.node_bound' });
    await assert.rejects(gateway.call(queryUpstream, { query: { kind: 'app_version', refId: dashboard, depth: 1 } }, cell.as(reviewer)),
      { category: 'bounds', code: 'lineage.depth_bound' });
  });

  test('the marking explanation follows each inherited marking to the node that carries it directly', async () => {
    const app = uuidv7();
    await write({ artefact: node('app_version', app), inputs: [{ node: node('view', restricted), relation: 'uses' }] });
    const explained = await gateway.call(explainMarkings, { query: { kind: 'app_version', refId: app } }, cell.as(cleared));
    const hrPath = explained.markings.find((m) => m.markingId === hr)!;
    assert.equal(hrPath.origin, 'inherited');
    assert.deepEqual(hrPath.path.map((s) => s.kind), ['view', 'object_type_version']);
    assert.equal(hrPath.path[1]!.refId, types['employee']);
    const direct = await gateway.call(explainMarkings, { query: { kind: 'object_type_version', refId: types['employee']! } }, cell.as(cleared));
    assert.deepEqual(direct.markings.map((m) => [m.markingId, m.origin]), [[hr, 'direct']]);
    await assert.rejects(gateway.call(explainMarkings, { query: { kind: 'app_version', refId: app } }, cell.as(reviewer)),
      { code: 'lineage.node_not_found' });
  });

  test('the access overlay counts the artefacts reached and the memberships who opened them, never who', async () => {
    const overlay = await gateway.call(accessOverlay, { query: { kind: 'connection', refId: connection } }, cell.as(reviewer));
    assert.deepEqual(overlay, { artefacts: 2, memberships: 0, withheld: 1 });
  });
});
