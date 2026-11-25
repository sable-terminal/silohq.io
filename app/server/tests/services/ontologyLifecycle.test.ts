// The deprecation lifecycle and rollback (spec 25.7, 25.8): deprecation names a replacement
// and a retirement date at least 30 days ahead and keeps the element usable, with a notice
// on every compile that uses it; retirement, from that date, takes it out of the new
// version's vocabulary while earlier versions keep it; a rollback is a proposal with the
// ordinary impact analysis and approvals, merged as a new main version of kind rollback that
// restores the prior content, bringing back what was retired since and retiring what was
// created since. Owners of every dependant are told at deprecation and seven days before
// retirement.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { listNotifications } from '../../src/contracts/notify/notification.contract.ts';
import { putObjectType } from '../../src/contracts/ontology/element.contract.ts';
import { deprecateElement, openRollback, retireElement } from '../../src/contracts/ontology/lifecycle.contract.ts';
import { getManifest, getVersionManifest, MANIFEST_SCHEMA_VERSION, type OntologyManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { approveProposal, mergeProposal, openBranch, submitProposal } from '../../src/contracts/ontology/proposal.contract.ts';
import type { QueryPlan } from '../../src/contracts/planner/plan.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createNotifyService } from '../../src/routes/notify/index.route.ts';
import { createOntologyService } from '../../src/routes/ontology/index.route.ts';
import type { RetirementReminders } from '../../src/services/ontology/retirementNotices.service.ts';
import { deprecationNotices } from '../../src/services/compile/compile.service.ts';
import { canonicalJsonBytes } from '../../src/utils/canonicalJson.util.ts';
import { sha256 } from '../../src/utils/crypto.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, restManifest, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let reader: ServiceClient;
let root: Signed;
let editor: Signed;
let viewer: Signed;
let crm = '';
let clock = (): Date => new Date();
let reminders: RetirementReminders;
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });
const source = (path: string) => ({ kind: 'rest', request: { method: 'GET', path, query: {} }, records: { jsonata: 'results' } });

const typeOver = (object: string, display: string) => ({
  displayName: display, pluralName: `${display}s`,
  contributingObjects: [{ connectionId: crm, sourceObject: object, identifierFieldPath: 'id' }],
  properties: [
    { apiName: 'ref', displayName: 'Ref', dataType: 'string' as const, mappings: [{ connectionId: crm, sourceObject: object, fieldPath: 'id' }] },
    { apiName: 'name', displayName: 'Name', dataType: 'string' as const, mappings: [{ connectionId: crm, sourceObject: object, fieldPath: 'name' }] },
  ],
  primaryKey: 'ref', title: 'name',
});

const rehash = (m: OntologyManifest): string => sha256(canonicalJsonBytes({
  schemaVersion: MANIFEST_SCHEMA_VERSION, objectTypes: m.objectTypes, linkTypes: m.linkTypes, sharedProperties: m.sharedProperties,
  interfaces: m.interfaces, functions: m.functions,
})).toString('hex');

const main = () => reader.call(getManifest, { query: {} }, cell.as(viewer));

/** Puts the types on a fresh branch and merges them through review. */
async function merge(types: Record<string, ReturnType<typeof typeOver>>) {
  const branch = await gateway.call(openBranch, { body: { name: `b ${uuidv7().slice(-8)}` } }, keyed(editor));
  for (const [apiName, body] of Object.entries(types)) {
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName }, body }, keyed(editor));
  }
  const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'types' } }, keyed(editor));
  await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
  return (await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root))).version;
}

const events = async (name: string) => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by created_at, id`,
  [cell.org, name]))).rows.map((r) => r.detail as Record<string, unknown>);

before(async () => {
  cell = await createConnectCell();
  await cell.start(createNotifyService({ sweep: false }), 'notify', 'test_app',
    { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_TLS: 'none', NOTIFY_LINK_BASE_URL: 'http://app.test/' });
  await cell.start(createOntologyService({ now: () => clock(), sweep: false, onReminders: (r) => { reminders = r; } }), 'ontology', 'test_app');
  gateway = cell.client('gateway');
  reader = cell.client('compile');
  root = await cell.signIn('root@acme.example');
  editor = await cell.member('editor@acme.example', 'Super admin');
  viewer = await cell.member('viewer@acme.example', 'Member');
  const connector = await gateway.call(createConnector, { body: { slug: 'crm', name: 'crm', provider: 'Example', sourceRoute: 'ai' } }, keyed(root));
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: restManifest({ baseUrl: 'https://api.example.com', objects: [
    { name: 'companies', identifier: ['id'], source: source('/v1/companies'), fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'name', type: 'string' }] },
    { name: 'organisations', identifier: ['id'], source: source('/v1/orgs'), fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'name', type: 'string' }] },
    { name: 'leads', identifier: ['id'], source: source('/v1/leads'), fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'name', type: 'string' }] },
  ] }) } }, keyed(root));
  crm = (await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'crm', owningScopeId: cell.scopes['engineering']! } }, keyed(root))).id;
});

after(async () => {
  await cell?.close();
});

let company = '';
let organisation = '';
let beforeDeprecation = '';

describe('deprecation and retirement (spec 25.7)', () => {
  test('deprecation names a replacement and a date at least 30 days ahead, by ontology.manage', async () => {
    beforeDeprecation = (await merge({ company: typeOver('companies', 'Company'), organisation: typeOver('organisations', 'Organisation') })).id;
    const m = await main();
    company = m.objectTypes.find((t) => t.apiName === 'company')!.id;
    organisation = m.objectTypes.find((t) => t.apiName === 'organisation')!.id;
    const body = (retireAfter: string, replacedById?: string) => ({ ...(replacedById ? { replacedById } : {}), retireAfter });
    await gateway.call(saveObjectSet, { body: {
      name: 'Companies', definition: { kind: 'filter', base: { objectTypeId: company }, predicate: { cel: 'true', properties: [] } },
    } }, keyed(editor));
    await assert.rejects(gateway.call(deprecateElement, { params: { kind: 'object_type', elementId: company }, body: body(day(10), organisation) },
      cell.as(root)), { code: 'ontology.retirement_too_soon' });
    await assert.rejects(gateway.call(deprecateElement, { params: { kind: 'object_type', elementId: company }, body: body(day(45), company) },
      cell.as(root)), { code: 'ontology.replacement_invalid' });
    await assert.rejects(gateway.call(deprecateElement, { params: { kind: 'object_type', elementId: company }, body: body(day(45), organisation) },
      cell.as(viewer)), { code: 'ontology.not_permitted' });
    const version = await gateway.call(deprecateElement, { params: { kind: 'object_type', elementId: company }, body: body(day(45), organisation) },
      cell.as(root));
    assert.equal(version.kind, 'change');
    const after = await main();
    const deprecated = after.objectTypes.find((t) => t.id === company)!;
    assert.deepEqual([deprecated.status, deprecated.replacedById, deprecated.retireAfter], ['deprecated', organisation, day(45)]);
    assert.equal(after.version.manifestHash, rehash(after));
    assert.equal(after.objectTypes.find((t) => t.id === organisation)!.retireAfter, undefined, 'an active element\'s manifest is unchanged');
    assert.equal((await events('element_deprecated'))[0]!['replaced_by'], organisation);
  });

  test('owners of every dependant are told at deprecation, and again seven days before retirement', async () => {
    const told = async (who: Signed) => (await gateway.call(listNotifications, { query: {} }, cell.as(who))).notifications
      .filter((n) => n.kind.startsWith('element_')).map((n) => n.kind).sort();
    assert.deepEqual(await told(editor), ['element_deprecated'], 'the object set\'s owner');
    assert.deepEqual(await told(viewer), [], 'no dependant of theirs');
    assert.deepEqual(await reminders.sendDue(uuidv7()), { sent: 0, cancelled: 0 }, 'not yet');
    clock = () => new Date(Date.now() + 38 * 86_400_000);
    assert.deepEqual(await reminders.sendDue(uuidv7()), { sent: 1, cancelled: 0 });
    assert.deepEqual(await reminders.sendDue(uuidv7()), { sent: 0, cancelled: 0 }, 'once');
    assert.deepEqual(await told(editor), ['element_deprecated', 'element_retiring']);
  });

  test('a deprecated element stays usable, and a compile that uses it carries the notice', async () => {
    const m = await main();
    const plan = { nodes: [{ objectTypeId: company }], hops: [] } as unknown as QueryPlan;
    assert.deepEqual(deprecationNotices(plan, m), [{
      kind: 'deprecated', elementKind: 'object_type', elementId: company, apiName: 'company', replacedById: organisation, retireAfter: day(45),
    }]);
    assert.deepEqual(deprecationNotices({ nodes: [{ objectTypeId: organisation }], hops: [] } as unknown as QueryPlan, m), []);
  });

  test('retirement waits for its date, then leaves the vocabulary of the new version only', async () => {
    await assert.rejects(gateway.call(retireElement, { params: { kind: 'object_type', elementId: company } }, cell.as(root)),
      { code: 'ontology.retirement_not_due' });
    await assert.rejects(gateway.call(retireElement, { params: { kind: 'object_type', elementId: organisation } }, cell.as(root)),
      { code: 'ontology.not_deprecated' });
    clock = () => new Date(Date.now() + 46 * 86_400_000);
    const version = await gateway.call(retireElement, { params: { kind: 'object_type', elementId: company } }, cell.as(root));
    const after = await main();
    assert.equal(after.version.id, version.id);
    assert.deepEqual(after.objectTypes.map((t) => t.apiName), ['organisation']);
    assert.equal(after.version.manifestHash, rehash(after));
    const earlier = await reader.call(getVersionManifest, { params: { versionId: beforeDeprecation } }, cell.as(viewer));
    assert.ok(earlier.objectTypes.some((t) => t.id === company), 'earlier versions keep it');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select status from ontology.object_types where id = $1', [company]));
    assert.equal(rows[0]!.status, 'retired');
    assert.equal((await events('element_retired')).length, 1);
  });
});

describe('lineage from the ontology (spec 59.2, 59.3)', () => {
  test('a type version on main has its properties as members, each fed by its source fields read via the connection; a saved set uses its type', async () => {
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select distinct f.kind || ':' || e.relation || ':' || t.kind as edge from gov.lineage_edges e
         join gov.lineage_nodes f on f.organisation_id = e.organisation_id and f.id = e.from_node_id
         join gov.lineage_nodes t on t.organisation_id = e.organisation_id and t.id = e.to_node_id
        where e.organisation_id = $1 order by 1`, [cell.org]));
    const edges = rows.map((r) => r.edge as string);
    for (const edge of ['connection:read_via:source_field', 'source_field:maps_to:property', 'property:member_of:object_type_version',
      'object_type_version:uses:object_set']) {
      assert.ok(edges.includes(edge), `${edge} is recorded`);
    }
  });
});

describe('rollback (spec 25.8)', () => {
  test('a rollback is reviewed like any proposal and merged as a new rollback version restoring the content', async () => {
    await merge({ lead: typeOver('leads', 'Lead') });
    const proposal = await gateway.call(openRollback, { body: { targetVersionId: beforeDeprecation, title: 'Back to before the rename' } }, cell.as(editor));
    assert.equal(proposal.origin, 'rollback');
    assert.equal(proposal.highestChangeClass, 'breaking');
    assert.deepEqual(proposal.changes.map((c) => `${c.apiName}:${c.operation}`).sort(), ['company:create', 'lead:retire']);
    assert.deepEqual(proposal.requires, { confirm: true, manage: true });
    await assert.rejects(gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root)), { code: 'ontology.proposal_not_approved' });
    await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
    await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.manage' } }, cell.as(root));
    const merged = await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
    assert.equal(merged.version.kind, 'rollback');
    const after = await main();
    const target = await reader.call(getVersionManifest, { params: { versionId: beforeDeprecation } }, cell.as(viewer));
    // Equal content; each restored object type is a new type version row, so its typeVersionId is new.
    const substance = (m: OntologyManifest) => JSON.stringify({ ...m, version: null, objectTypes: m.objectTypes.map(({ typeVersionId: _v, ...t }) => t) });
    assert.equal(substance(after), substance(target), 'content equals the version restored');
    assert.equal(after.version.manifestHash, rehash(after));
    assert.deepEqual(after.objectTypes.map((t) => `${t.apiName}:${t.status}`).sort(), ['company:active', 'organisation:active']);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select api_name, status from ontology.object_types where organisation_id = $1 order by api_name`, [cell.org]));
    assert.deepEqual(rows.map((r) => `${r.api_name}:${r.status}`), ['company:active', 'lead:retired', 'organisation:active']);
    const { rows: versions } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select rolled_back_to_version_id from ontology.ontology_versions where id = $1', [merged.version.id]));
    assert.equal(versions[0]!.rolled_back_to_version_id, beforeDeprecation);
    const [rolled] = await events('ontology_rolled_back');
    assert.deepEqual([rolled!['to_version_id'], rolled!['restored'], rolled!['retired']], [beforeDeprecation, 1, 1]);
  });

  test('a rollback names a version of main other than its head', async () => {
    const head = (await main()).version.id;
    await assert.rejects(gateway.call(openRollback, { body: { targetVersionId: head, title: 'x' } }, cell.as(editor)), { code: 'ontology.rollback_to_head' });
    await assert.rejects(gateway.call(openRollback, { body: { targetVersionId: uuidv7(), title: 'x' } }, cell.as(editor)),
      { code: 'ontology.rollback_target_invalid' });
  });
});
