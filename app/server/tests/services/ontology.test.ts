// The ontology service end to end (spec 21, 22, 24.4, 25): main created on first touch;
// elements authored on branches against connections' declared schemas and refused where
// the source does not declare them; functions type-checked; proposals with change classes,
// impact from the dependency index, two-person approval and an extra ontology.manage
// approval for breaking changes; rebase with conflicts; merge into immutable versions whose
// hash is the content's; derivation confirmed decision by decision; saved object sets.
// Real processes: credential, policy, auth, connect-registry and ontology.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { putFunction, putLinkType, putObjectType, putSharedProperty } from '../../src/contracts/ontology/element.contract.ts';
import {
  getActiveVersion, getManifest, getVersionManifest, MANIFEST_SCHEMA_VERSION, type OntologyManifest,
} from '../../src/contracts/ontology/manifest.contract.ts';
import { archiveObjectSet, getObjectSet, listObjectSets, saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import {
  approveProposal, confirmDecisions, getBranch, getBranchChanges, getProposal, mergeProposal, openBranch, rebaseBranch, startDerivation,
  submitProposal, withdrawProposal,
} from '../../src/contracts/ontology/proposal.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { canonicalJsonBytes } from '../../src/utils/canonicalJson.util.ts';
import { sha256 } from '../../src/utils/crypto.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, restManifest, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let compile: ServiceClient;
let root: Signed;
let editor: Signed;
let viewer: Signed;
let crm: string;
let accounts: string;

const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });

const source = (path: string) => ({ kind: 'rest', request: { method: 'GET', path, query: {} }, records: { jsonata: 'results' } });

async function connection(slug: string, objects: unknown[]): Promise<string> {
  const connector = await gateway.call(createConnector, { body: { slug, name: slug, provider: 'Example', sourceRoute: 'ai' } }, keyed(root));
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: restManifest({ baseUrl: 'https://api.example.com', objects }) } },
    keyed(root));
  const created = await gateway.call(createConnection, { body: { connectorId: connector.id, name: slug, owningScopeId: cell.scopes['engineering']! } }, keyed(root));
  return created.id;
}

const companyType = (extra: Record<string, unknown> = {}) => ({
  displayName: 'Company', pluralName: 'Companies',
  contributingObjects: [{ connectionId: crm, sourceObject: 'companies', identifierFieldPath: 'id' }],
  properties: [
    { apiName: 'company_id', displayName: 'Company id', dataType: 'string' as const, mappings: [{ connectionId: crm, sourceObject: 'companies', fieldPath: 'id' }] },
    { apiName: 'name', displayName: 'Name', dataType: 'string' as const, mappings: [{ connectionId: crm, sourceObject: 'companies', fieldPath: 'name' }] },
    { apiName: 'created', displayName: 'Created', dataType: 'timestamp' as const, mappings: [{ connectionId: crm, sourceObject: 'companies', fieldPath: 'created_at' }] },
  ],
  primaryKey: 'company_id', title: 'name', timeFields: [{ property: 'created', meaning: 'created', isDefault: true }],
  ...extra,
});

const contactType = () => ({
  displayName: 'Contact', pluralName: 'Contacts',
  contributingObjects: [{ connectionId: crm, sourceObject: 'contacts', identifierFieldPath: 'id' }],
  properties: [
    { apiName: 'contact_id', displayName: 'Contact id', dataType: 'string' as const, mappings: [{ connectionId: crm, sourceObject: 'contacts', fieldPath: 'id' }] },
    { apiName: 'email', displayName: 'Email', dataType: 'string' as const, mappings: [{ connectionId: crm, sourceObject: 'contacts', fieldPath: 'email' }] },
    { apiName: 'company_ref', displayName: 'Company', dataType: 'string' as const, mappings: [{ connectionId: crm, sourceObject: 'contacts', fieldPath: 'company_id' }] },
    { apiName: 'score', displayName: 'Score', dataType: 'integer' as const, mappings: [{ connectionId: crm, sourceObject: 'contacts', fieldPath: 'score' }] },
  ],
  primaryKey: 'contact_id', title: 'email',
});

/** The manifest hash, recomputed from what the manifest says. */
const rehash = (m: OntologyManifest): string => sha256(canonicalJsonBytes({
  schemaVersion: MANIFEST_SCHEMA_VERSION, objectTypes: m.objectTypes, linkTypes: m.linkTypes, sharedProperties: m.sharedProperties,
  interfaces: m.interfaces, functions: m.functions,
})).toString('hex');

const events = async (): Promise<string[]> => {
  const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `select payload->>'event' as event from platform.outbox where organisation_id = $1 and event = 'audit_event' order by created_at, id`, [cell.org]));
  return rows.map((r) => r.event as string);
};

before(async () => {
  cell = await createConnectCell();
  await cell.start(ontologyService, 'ontology', 'test_app');
  gateway = cell.client('gateway');
  compile = cell.client('compile');
  root = await cell.signIn('root@acme.example');
  editor = await cell.member('editor@acme.example', 'Super admin');
  viewer = await cell.member('viewer@acme.example', 'Member');
  crm = await connection('crm', [
    { name: 'companies', identifier: ['id'], source: source('/v1/companies'), fields: [
      { name: 'id', type: 'string', nullable: false }, { name: 'name', type: 'string' }, { name: 'reg_no', type: 'string' },
      { name: 'created_at', type: 'date-time' }] },
    { name: 'contacts', identifier: ['id'], source: source('/v1/contacts'), fields: [
      { name: 'id', type: 'string', nullable: false }, { name: 'email', type: 'string' }, { name: 'company_id', type: 'string' },
      { name: 'score', type: 'integer' }],
      relationships: [{ field: 'company_id', targetObject: 'companies', targetField: 'id', kind: 'foreign_key' }] },
  ]);
  accounts = await connection('accounts', [
    { name: 'customers', identifier: ['number'], source: source('/v1/customers'), fields: [
      { name: 'number', type: 'string', nullable: false }, { name: 'trading_name', type: 'string' }, { name: 'reg_no', type: 'string' }] },
  ]);
});

after(async () => {
  await cell?.close();
});

describe('main and the manifest (spec 25.1, 25.3)', () => {
  test('main exists from the first read, with an empty first version every reader sees', async () => {
    const manifest = await compile.call(getManifest, { query: {} }, cell.as(root));
    assert.equal(manifest.schemaVersion, '1');
    assert.equal(manifest.version.branchKind, 'main');
    assert.equal(manifest.version.sequence, 1);
    assert.deepEqual(manifest.objectTypes, []);
    assert.equal(manifest.version.manifestHash, rehash(manifest));
    const active = await gateway.call(getActiveVersion, { query: {} }, cell.as(viewer));
    assert.equal(active.id, manifest.version.id);
  });
});

describe('authoring on a branch (spec 21.5 to 21.11)', () => {
  let branchId: string;
  let companyId: string;

  test('a branch opens at main\'s head; a member without ontology.branch cannot open one', async () => {
    const branch = await gateway.call(openBranch, { body: { name: 'customer model' } }, keyed(editor));
    assert.equal(branch.kind, 'working');
    assert.equal(branch.behindMain, false);
    branchId = branch.id;
    await assert.rejects(gateway.call(openBranch, { body: { name: 'mine' } }, keyed(viewer)), { code: 'ontology.not_permitted' });
    await assert.rejects(gateway.call(openBranch, { body: { name: 'Customer Model' } }, keyed(editor)), { code: 'ontology.branch_name_taken' });
  });

  test('an object type over a declared source object is committed on the branch; main does not change', async () => {
    const key = uuidv7();
    const first = await gateway.call(putObjectType, { params: { branchId, apiName: 'company' }, body: companyType() }, { ...cell.as(editor), idempotencyKey: key });
    const again = await gateway.call(putObjectType, { params: { branchId, apiName: 'company' }, body: companyType() }, { ...cell.as(editor), idempotencyKey: key });
    assert.deepEqual(again, first, 'a retried commit returns the first');
    companyId = first.element.id;
    assert.equal(first.element.status, 'proposed');
    assert.equal(first.element.resolutionClass, 'single_source');
    assert.equal(first.element.contributingObjects[0]!.connectorVersion, '1.0.0');
    assert.equal(first.element.properties.find((p) => p.apiName === 'created')!.mappings[0]!.confidence, 1);
    assert.equal(first.version.branchKind, 'working');
    const branchManifest = await gateway.call(getManifest, { query: { branchId } }, cell.as(editor));
    assert.equal(branchManifest.version.id, first.version.id);
    assert.equal(branchManifest.version.manifestHash, rehash(branchManifest), 'the stored hash is the content\'s');
    assert.deepEqual((await gateway.call(getManifest, { query: {} }, cell.as(editor))).objectTypes, []);
    const unchanged = await gateway.call(putObjectType, { params: { branchId, apiName: 'company' }, body: companyType() }, keyed(editor));
    assert.equal(unchanged.version.id, first.version.id, 'writing the same definition commits nothing');
  });

  test('what the source does not declare is refused, field by field', async () => {
    const put = (body: object) => gateway.call(putObjectType, { params: { branchId, apiName: 'broken' }, body: body as never }, keyed(editor));
    const base = companyType();
    await assert.rejects(put({ ...base, properties: [...base.properties, { apiName: 'vat', displayName: 'VAT', dataType: 'string',
      mappings: [{ connectionId: crm, sourceObject: 'companies', fieldPath: 'vat_number' }] }] }), { code: 'ontology.source_field_unknown' });
    await assert.rejects(put({ ...base, properties: [...base.properties, { apiName: 'email', displayName: 'Email', dataType: 'string',
      mappings: [{ connectionId: crm, sourceObject: 'contacts', fieldPath: 'email' }] }] }), { code: 'ontology.mapping_source' });
    await assert.rejects(put({ ...base, contributingObjects: [{ connectionId: crm, sourceObject: 'invoices', identifierFieldPath: 'id' }] }),
      { code: 'ontology.source_object_unknown' });
    await assert.rejects(put({ ...base, timeFields: [{ property: 'name', meaning: 'named' }] }), { code: 'ontology.time_field_type' });
    await assert.rejects(put({ ...base, primaryKey: undefined }), { code: 'ontology.primary_key_required' });
    await assert.rejects(put({
      ...base, primaryKey: undefined,
      contributingObjects: [...base.contributingObjects, { connectionId: accounts, sourceObject: 'customers', identifierFieldPath: 'number' }],
    }), { code: 'ontology.match_keys_required' });
    await assert.rejects(gateway.call(putObjectType, { params: { branchId, apiName: 'other' }, body: companyType() }, keyed(viewer)),
      { code: 'ontology.not_permitted' });
  });

  test('a property keeps its identity across versions, renamed or not; a second system makes the type resolvable', async () => {
    const before = (await gateway.call(getManifest, { query: { branchId } }, cell.as(editor))).objectTypes.find((t) => t.id === companyId)!;
    const base = companyType();
    const next = await gateway.call(putObjectType, {
      params: { branchId, apiName: 'company' },
      body: {
        ...base, primaryKey: undefined,
        contributingObjects: [...base.contributingObjects, { connectionId: accounts, sourceObject: 'customers', identifierFieldPath: 'number' }],
        properties: [
          ...base.properties.map((p) => (p.apiName === 'name' ? { ...p, apiName: 'legal_name', previousApiName: 'name',
            mappings: [...p.mappings, { connectionId: accounts, sourceObject: 'customers', fieldPath: 'trading_name' }] } : p)),
          { apiName: 'registration', displayName: 'Registration', dataType: 'string', mappings: [
            { connectionId: crm, sourceObject: 'companies', fieldPath: 'reg_no' }, { connectionId: accounts, sourceObject: 'customers', fieldPath: 'reg_no' }] },
        ],
        title: 'legal_name', matchKeys: [{ property: 'registration', normalisation: 'value.trim()' }],
      },
    }, keyed(editor));
    const after = next.element;
    assert.equal(after.resolutionClass, 'resolvable');
    assert.equal(after.primaryKeyPropertyIdentityId, null);
    assert.equal(after.properties.find((p) => p.apiName === 'legal_name')!.identityId, before.properties.find((p) => p.apiName === 'name')!.identityId);
    assert.equal(after.properties.find((p) => p.apiName === 'company_id')!.identityId, before.properties.find((p) => p.apiName === 'company_id')!.identityId);
    assert.equal(after.matchKeys.length, 1);
    assert.ok(after.properties.find((p) => p.apiName === 'registration')!.isMatchKey);
    assert.notEqual(after.typeVersionId, before.typeVersionId);
  });

  test('a link stands on a declared key or a person\'s declaration, never a guess (spec 21.8)', async () => {
    await gateway.call(putObjectType, { params: { branchId, apiName: 'contact' }, body: contactType() }, keyed(editor));
    const route = { connectionId: crm, sourceObject: 'contacts', foreignKeyField: 'company_id', referencedField: 'id' };
    const link = await gateway.call(putLinkType, {
      params: { branchId, apiName: 'company_contacts' },
      body: { forwardName: 'employs', reverseName: 'works for', from: 'company', to: 'contact', cardinality: 'one_to_many',
        routes: [{ ...route, origin: 'declared_fk' }], defaultRoute: 0 },
    }, keyed(editor));
    assert.equal(link.element.routes[0]!.origin, 'declared_fk');
    assert.equal(link.element.defaultRouteId, link.element.routes[0]!.id);
    await assert.rejects(gateway.call(putLinkType, {
      params: { branchId, apiName: 'guessed' },
      body: { forwardName: 'a', reverseName: 'b', from: 'company', to: 'contact', cardinality: 'one_to_many',
        routes: [{ ...route, foreignKeyField: 'email', origin: 'declared_fk' }] },
    }, keyed(editor)), { code: 'ontology.route_not_declared' });
    await assert.rejects(gateway.call(putLinkType, {
      params: { branchId, apiName: 'junctionless' },
      body: { forwardName: 'a', reverseName: 'b', from: 'company', to: 'contact', cardinality: 'many_to_many', routes: [route] },
    }, keyed(editor)), { code: 'ontology.junction_required' });
  });

  test('functions are CEL that type-checks; a computed property names a version and returns its type', async () => {
    const fn = await gateway.call(putFunction, {
      params: { branchId, apiName: 'score_band' },
      body: { kind: 'computed_property', expression: 'object.score > 50 ? "high" : "low"',
        inputs: { properties: [{ objectType: 'contact', property: 'score' }] }, outputType: { dataType: 'string' } },
    }, keyed(editor));
    assert.equal(fn.element.version.version, 1);
    assert.equal(fn.element.version.inputs.propertyIdentityIds.length, 1);
    await assert.rejects(gateway.call(putFunction, {
      params: { branchId, apiName: 'broken_fn' }, body: { kind: 'ranking', expression: 'object.score +', inputs: {}, outputType: { dataType: 'integer' } },
    }, keyed(editor)), { code: 'ontology.function_invalid' });
    const contact = contactType();
    const withBand = await gateway.call(putObjectType, {
      params: { branchId, apiName: 'contact' },
      body: { ...contact, properties: [...contact.properties, { apiName: 'band', displayName: 'Band', dataType: 'string', computedFunctionVersionId: fn.element.version.id }] },
    }, keyed(editor));
    assert.equal(withBand.element.properties.find((p) => p.apiName === 'band')!.computedFunctionVersionId, fn.element.version.id);
    await assert.rejects(gateway.call(putObjectType, {
      params: { branchId, apiName: 'contact' },
      body: { ...contact, properties: [...contact.properties, { apiName: 'band', displayName: 'Band', dataType: 'integer', computedFunctionVersionId: fn.element.version.id }] },
    }, keyed(editor)), { code: 'ontology.function_output_type' });
  });

  test('a proposal carries the diff and its classes; the author never approves; approval then merge makes a main version', async () => {
    const changes = await gateway.call(getBranchChanges, { params: { branchId } }, cell.as(editor));
    assert.deepEqual(changes.changes.map((c) => `${c.kind}:${c.apiName}:${c.changeClass}`).sort(),
      ['function:score_band:additive', 'link_type:company_contacts:additive', 'object_type:company:additive', 'object_type:contact:additive']);
    const proposal = await gateway.call(submitProposal, { params: { branchId }, body: { title: 'Customers and their contacts' } }, keyed(editor));
    assert.equal(proposal.status, 'in_review');
    assert.equal(proposal.highestChangeClass, 'additive');
    assert.equal(proposal.impact!.total, 0);
    assert.deepEqual(proposal.requires, { confirm: true, manage: false });
    await assert.rejects(gateway.call(putObjectType, { params: { branchId, apiName: 'contact' }, body: contactType() }, keyed(editor)),
      { code: 'ontology.branch_in_review' });
    await assert.rejects(gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(editor)),
      { code: 'ontology.author_cannot_approve' });
    await assert.rejects(gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root)), { code: 'ontology.proposal_not_approved' });
    const approved = await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
    assert.equal(approved.status, 'approved');

    const merged = await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
    assert.equal(merged.proposal.status, 'merged');
    assert.equal(merged.version.kind, 'merge');
    assert.equal(merged.version.branchKind, 'main');
    const main = await compile.call(getManifest, { query: {} }, cell.as(viewer));
    assert.equal(main.version.id, merged.version.id);
    assert.equal(main.version.manifestHash, rehash(main));
    assert.deepEqual(main.objectTypes.map((t) => `${t.apiName}:${t.status}`), ['company:active', 'contact:active']);
    assert.equal(main.linkTypes[0]!.status, 'active');
    assert.equal(main.functions[0]!.apiName, 'score_band');
    const branchView = await gateway.call(getBranch, { params: { branchId } }, cell.as(editor));
    assert.equal(branchView.status, 'merged');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select t.status, t.confirmed_by, t.origin_branch_id, t.current_version_id = v.id as current
         from ontology.object_types t join ontology.object_type_versions v on v.object_type_id = t.id and v.ontology_version_id = $2
        where t.id = $1`, [companyId, merged.version.id]));
    assert.deepEqual(rows[0], { status: 'active', confirmed_by: root.membershipId, origin_branch_id: null, current: true });
    // An earlier version keeps its content: versions are immutable.
    const first = await compile.call(getVersionManifest, { params: { versionId: main.version.parentVersionId! } }, cell.as(viewer));
    assert.deepEqual(first.objectTypes, []);
    const audited = await events();
    for (const e of ['ontology_branch_opened', 'object_type_proposed', 'property_mapped', 'link_type_proposed', 'function_version_published',
      'ontology_proposal_submitted', 'ontology_impact_computed', 'ontology_proposal_approved', 'ontology_proposal_merged', 'object_type_confirmed',
      'link_type_confirmed']) {
      assert.ok(audited.includes(e), e);
    }
  });
});

describe('breaking changes, impact and rebase (spec 25.4 to 25.6)', () => {
  let setId: string;

  test('a saved object set records what it depends on', async () => {
    const main = await compile.call(getManifest, { query: {} }, cell.as(root));
    const company = main.objectTypes.find((t) => t.apiName === 'company')!;
    const legal = company.properties.find((p) => p.apiName === 'legal_name')!;
    const set = await gateway.call(saveObjectSet, {
      body: { name: 'Acme-like companies', definition: { kind: 'filter', base: { objectTypeId: company.id },
        predicate: { cel: 'object.legal_name.startsWith("A")', properties: [legal.identityId] } } },
    }, keyed(viewer));
    setId = set.id;
    assert.equal(set.ontologyVersionId, main.version.id);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select count(*)::int as n from ontology.ontology_dependencies where object_set_id = $1 and removed_at is null', [setId]));
    assert.equal(rows[0].n, 2);
  });

  test('a breaking change needs ontology.manage too, counts the dependants that will fail, and merges only rebased', async () => {
    const main = await compile.call(getManifest, { query: {} }, cell.as(root));
    const typeBody = (m: OntologyManifest, overrides: { legalType?: 'string' | 'integer'; display?: string } = {}) => {
      const company = companyType();
      return {
        ...company, displayName: overrides.display ?? m.objectTypes.find((t) => t.apiName === 'company')!.displayName, primaryKey: undefined,
        contributingObjects: [...company.contributingObjects, { connectionId: accounts, sourceObject: 'customers', identifierFieldPath: 'number' }],
        properties: [
          ...company.properties.filter((p) => p.apiName !== 'name'),
          { apiName: 'legal_name', displayName: 'Name', dataType: overrides.legalType ?? 'string' as const, mappings: [
            { connectionId: crm, sourceObject: 'companies', fieldPath: 'name' }, { connectionId: accounts, sourceObject: 'customers', fieldPath: 'trading_name' }] },
          { apiName: 'registration', displayName: 'Registration', dataType: 'string' as const, mappings: [
            { connectionId: crm, sourceObject: 'companies', fieldPath: 'reg_no' }, { connectionId: accounts, sourceObject: 'customers', fieldPath: 'reg_no' }] },
        ],
        title: 'legal_name', matchKeys: [{ property: 'registration', normalisation: 'value.trim()' }],
      };
    };
    // The editor's branch changes a property's type: breaking.
    const editing = await gateway.call(openBranch, { body: { name: 'legal name as number' } }, keyed(editor));
    await gateway.call(putObjectType, { params: { branchId: editing.id, apiName: 'company' }, body: typeBody(main, { legalType: 'integer' }) }, keyed(editor));
    const proposal = await gateway.call(submitProposal, { params: { branchId: editing.id }, body: { title: 'Number the names' } }, keyed(editor));
    assert.equal(proposal.highestChangeClass, 'breaking');
    assert.ok(proposal.changes[0]!.notes.includes('property_type_changed'));
    assert.equal(proposal.impact!.byEffect['will_fail'], 1, 'the saved set reads the property');
    assert.equal(proposal.impact!.byKind['object_set'], 1);
    assert.deepEqual(proposal.requires, { confirm: true, manage: true });
    const confirmed = await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
    assert.equal(confirmed.status, 'in_review');
    const approved = await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.manage' } }, cell.as(root));
    assert.equal(approved.status, 'approved');

    // Meanwhile main moves: root renames the type's display name on another branch.
    const other = await gateway.call(openBranch, { body: { name: 'display' } }, keyed(root));
    await gateway.call(putObjectType, { params: { branchId: other.id, apiName: 'company' }, body: typeBody(main, { display: 'Organisation' }) }, keyed(root));
    const displayProposal = await gateway.call(submitProposal, { params: { branchId: other.id }, body: { title: 'Call them organisations' } }, keyed(root));
    assert.equal(displayProposal.highestChangeClass, 'compatible');
    await gateway.call(approveProposal, { params: { proposalId: displayProposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(editor));
    await gateway.call(mergeProposal, { params: { proposalId: displayProposal.id } }, keyed(editor));

    await assert.rejects(gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root)), { code: 'ontology.rebase_required' });
    assert.equal((await gateway.call(getBranch, { params: { branchId: editing.id } }, cell.as(editor))).behindMain, true);
    const conflicted = await gateway.call(rebaseBranch, { params: { branchId: editing.id }, body: {} }, cell.as(editor));
    assert.equal(conflicted.rebased, false);
    assert.deepEqual(conflicted.conflicts.map((c) => c.apiName), ['company']);
    const companyId = conflicted.conflicts[0]!.id;
    const rebased = await gateway.call(rebaseBranch, { params: { branchId: editing.id }, body: { resolutions: { [companyId]: 'branch' } } }, cell.as(editor));
    assert.equal(rebased.rebased, true);
    assert.equal(rebased.branch.behindMain, false);
    // The diff changed (the branch's version also restores the old display name), so the
    // approved proposal is withdrawn and a fresh one opened.
    assert.equal((await gateway.call(getProposal, { params: { proposalId: proposal.id } }, cell.as(editor))).status, 'withdrawn');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select id from ontology.ontology_proposals where branch_id = $1 and status = 'in_review'`, [editing.id]));
    const renewed = rows[0].id as string;
    const fresh = await gateway.call(getProposal, { params: { proposalId: renewed } }, cell.as(editor));
    assert.ok(fresh.changes[0]!.notes.includes('display_name_changed'));
    await gateway.call(approveProposal, { params: { proposalId: renewed }, body: { permission: 'ontology.confirm' } }, cell.as(root));
    await gateway.call(approveProposal, { params: { proposalId: renewed }, body: { permission: 'ontology.manage' } }, cell.as(root));
    const merged = await gateway.call(mergeProposal, { params: { proposalId: renewed } }, keyed(root));
    const after = await compile.call(getVersionManifest, { params: { versionId: merged.version.id } }, cell.as(root));
    assert.equal(after.objectTypes.find((t) => t.apiName === 'company')!.properties.find((p) => p.apiName === 'legal_name')!.dataType, 'integer');
    assert.equal(after.version.manifestHash, rehash(after));
  });

  test('a withdrawn proposal frees its branch; another member\'s private set is not theirs to see', async () => {
    const branch = await gateway.call(openBranch, { body: { name: 'withdraw me' } }, keyed(editor));
    const main = await compile.call(getManifest, { query: {} }, cell.as(root));
    await gateway.call(putSharedProperty, { params: { branchId: branch.id, apiName: 'status' }, body: { displayName: 'Status', dataType: 'enum' } }, keyed(editor));
    const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Status' } }, keyed(editor));
    await assert.rejects(gateway.call(withdrawProposal, { params: { proposalId: proposal.id } }, cell.as(viewer)), { code: 'ontology.not_author' });
    assert.equal((await gateway.call(withdrawProposal, { params: { proposalId: proposal.id } }, cell.as(editor))).status, 'withdrawn');
    assert.equal(main.sharedProperties.length, 0);
    await assert.rejects(gateway.call(getObjectSet, { params: { objectSetId: setId } }, cell.as(editor)), { code: 'object_set.not_found' });
    assert.equal((await gateway.call(listObjectSets, { query: {} }, cell.as(viewer))).objectSets.length, 1);
    const archived = await gateway.call(archiveObjectSet, { params: { objectSetId: setId } }, cell.as(viewer));
    assert.equal(archived.id, setId);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select count(*)::int as n from ontology.ontology_dependencies where object_set_id = $1 and removed_at is null', [setId]));
    assert.equal(rows[0].n, 0, 'a removed set depends on nothing');
  });

  test('object set definitions are checked against main', async () => {
    const main = await compile.call(getManifest, { query: {} }, cell.as(root));
    const company = main.objectTypes.find((t) => t.apiName === 'company')!;
    const contact = main.objectTypes.find((t) => t.apiName === 'contact')!;
    const link = main.linkTypes[0]!;
    const save = (definition: object) => gateway.call(saveObjectSet, { body: { name: `set ${uuidv7()}`, definition: definition as never } }, keyed(viewer));
    await assert.rejects(save({ kind: 'filter', base: { objectTypeId: company.id }, predicate: { cel: 'object.x ==', properties: [] } }),
      { code: 'object_set.predicate_invalid' });
    await assert.rejects(save({ kind: 'filter', base: { objectTypeId: company.id }, predicate: { cel: 'true', properties: [contact.properties[0]!.identityId] } }),
      { code: 'object_set.property_unknown' });
    await assert.rejects(save({ kind: 'filter', base: { objectTypeId: company.id }, predicate: { cel: 'object.email == "ada@example.com"', properties: [] } }),
      { code: 'object_set.value_in_definition' });
    await assert.rejects(save({ kind: 'traversal', start: { objectTypeId: contact.id }, path: [{ linkTypeId: link.id, direction: 'forward' }] }),
      { code: 'object_set.path_broken' });
    const walk = await save({ kind: 'traversal', start: { objectTypeId: company.id }, path: [{ linkTypeId: link.id, direction: 'forward' }] });
    assert.equal(walk.baseTypeId, contact.id, 'a traversal is a set of where it ends');
  });
});

describe('derivation and confirmation (spec 22)', () => {
  test('derivation proposes filled in from the declared schema; the requester cannot confirm; what is accepted merges, the rest waits', async () => {
    const proposal = await gateway.call(startDerivation, { body: { connectionId: crm } }, keyed(editor));
    assert.equal(proposal.origin, 'derivation');
    assert.equal(proposal.changes.length, 0, 'nothing exists until a person confirms');
    const types = proposal.decisions.filter((d) => d.kind === 'object_type');
    const links = proposal.decisions.filter((d) => d.kind === 'link_type');
    assert.deepEqual(types.map((d) => d.apiName).sort(), ['companies', 'contacts']);
    assert.equal(links.length, 1);
    assert.equal(links[0]!.evidence[0]!.source, 'declared_fk');
    const contacts = types.find((d) => d.apiName === 'contacts')!;
    assert.equal(contacts.kind === 'object_type' && contacts.definition.title, 'email', 'no field is named like a title: the first text field');
    assert.equal(contacts.confidence, 0.6, 'a guessed title lowers the confidence, and says why');

    await assert.rejects(gateway.call(confirmDecisions, { params: { proposalId: proposal.id }, body: { decisions: [{ decisionId: contacts.id, action: 'accept' }] } },
      keyed(editor)), { code: 'ontology.author_cannot_approve' });
    await assert.rejects(gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root)),
      { code: 'ontology.decisions_pending' });

    const companies = types.find((d) => d.apiName === 'companies')!;
    const corrected = companies.kind === 'object_type' ? { ...companies.definition, displayName: 'Firm', pluralName: 'Firms' } : undefined;
    const outcome = await gateway.call(confirmDecisions, {
      params: { proposalId: proposal.id },
      body: { decisions: [{ decisionId: contacts.id, action: 'accept' }, { decisionId: companies.id, action: 'correct', objectType: corrected }] },
    }, keyed(root));
    assert.equal(outcome.proposal.status, 'approved', 'the confirmer\'s decisions are the confirm approval');
    assert.ok(outcome.followUpProposalId, 'the undecided link waits in its own proposal');
    assert.deepEqual(outcome.proposal.decisions.map((d) => d.status).sort(), ['accepted', 'corrected']);
    const merged = await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
    const main = await compile.call(getVersionManifest, { params: { versionId: merged.version.id } }, cell.as(root));
    const contactsType = main.objectTypes.find((t) => t.apiName === 'contacts')!;
    assert.equal(contactsType.status, 'active');
    assert.equal(contactsType.properties[0]!.mappings[0]!.confidence, 0.9, 'an accepted mapping keeps the derivation\'s confidence');
    assert.equal(main.objectTypes.find((t) => t.apiName === 'companies')!.displayName, 'Firm');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select distinct m.confirmed_by from ontology.property_mappings m join ontology.object_types t on t.current_version_id = m.object_type_version_id
        where t.api_name = 'contacts'`));
    assert.deepEqual(rows.map((r) => r.confirmed_by), [root.membershipId], 'the confirming person confirmed every mapping');

    // The waiting link: its branch is rebased onto the main that now holds its types, then confirmed.
    const follow = await gateway.call(getProposal, { params: { proposalId: outcome.followUpProposalId! } }, cell.as(root));
    await gateway.call(rebaseBranch, { params: { branchId: follow.branchId }, body: {} }, cell.as(root));
    const link = follow.decisions[0]!;
    const linked = await gateway.call(confirmDecisions, { params: { proposalId: follow.id }, body: { decisions: [{ decisionId: link.id, action: 'accept' }] } },
      keyed(root));
    assert.equal(linked.proposal.status, 'approved');
    const final = await gateway.call(mergeProposal, { params: { proposalId: follow.id } }, keyed(root));
    const withLink = await compile.call(getVersionManifest, { params: { versionId: final.version.id } }, cell.as(root));
    const derived = withLink.linkTypes.find((l) => l.apiName === link.apiName)!;
    assert.equal(derived.fromTypeId, withLink.objectTypes.find((t) => t.apiName === 'companies')!.id);
    assert.equal(derived.cardinality, 'one_to_many');
    const audited = await events();
    for (const e of ['derivation_started', 'derivation_completed', 'proposal_created', 'proposal_decision_confirmed', 'proposal_decision_corrected']) {
      assert.ok(audited.includes(e), e);
    }
  });
});

describe('who may do what (spec 21.17, 25.10)', () => {
  test('an author without ontology.manage proposes types, but not visual metadata, shared properties or merges', async () => {
    const role = uuidv7();
    await inTx(cell.app, { orgId: cell.org }, async () => {
      await cell.app.query(`insert into iam.roles (id, organisation_id, name) values ($1, $2, 'Ontology author')`, [role, cell.org]);
      for (const permission of ['ontology.view', 'ontology.propose', 'ontology.branch']) {
        await cell.app.query('insert into iam.role_permissions (organisation_id, role_id, permission_id) values ($1, $2, $3)', [cell.org, role, permission]);
      }
      await cell.app.query('insert into iam.role_grantable_roles (organisation_id, granting_role_id, grantable_role_id) values ($1, $2, $3)',
        [cell.org, cell.roles['Super admin'], role]);
    });
    cell.roles['Ontology author'] = role;
    const author = await cell.member('author@acme.example', 'Ontology author');
    const branch = await gateway.call(openBranch, { body: { name: 'author branch' } }, keyed(author));
    const body = { ...contactType(), displayName: 'Person', pluralName: 'People' };
    const renamed = await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'contact' }, body }, keyed(author));
    assert.equal(renamed.element.displayName, 'Person');
    await assert.rejects(gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'contact' }, body: { ...body, visual: { icon: 'person' } } },
      keyed(author)), { code: 'ontology.not_permitted', message: 'you do not hold ontology.manage' });
    await assert.rejects(gateway.call(putSharedProperty, { params: { branchId: branch.id, apiName: 'region' }, body: { displayName: 'Region', dataType: 'string' } },
      keyed(author)), { code: 'ontology.not_permitted' });
    // Someone else's branch takes their commits only with ontology.manage.
    const theirs = await gateway.call(openBranch, { body: { name: 'editor branch' } }, keyed(editor));
    await assert.rejects(gateway.call(putObjectType, { params: { branchId: theirs.id, apiName: 'contact' }, body }, keyed(author)),
      { code: 'ontology.not_branch_owner' });
    const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'People' } }, keyed(author));
    await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
    await assert.rejects(gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(author)), { code: 'ontology.not_permitted' });
  });
});

void doc;

describe('mappings removed (21.6, 21.17)', () => {
  test('a property that stops reading a source field is audited as unmapped, by count', async () => {
    const branch = await gateway.call(openBranch, { body: { name: 'unmapping' } }, keyed(editor));
    const body = companyType({ timeFields: [] });
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'company_probe' }, body }, keyed(editor));
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'company_probe' },
      body: { ...body, properties: body.properties.filter((p) => p.apiName !== 'created') } }, keyed(editor));
    const { rows } = await cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'property_unmapped' order by seq`, [cell.org]);
    assert.deepEqual(rows.map((r) => r.detail.mappings), [1], 'the created_at mapping, gone with its property');
  });
});
