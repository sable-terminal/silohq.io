// Search end to end (spec 24.5, 33.5, 34.1): ontology search over the person's vocabulary,
// and federated object search pushed to each source that declares a native filter on the
// title, bounded per source, naming every source not searched and why.
// Real processes: credential, policy, auth, connect-registry, connect-runtime, pushdown-compiler,
// expression-evaluator, ontology and search, against a fake CRM.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { putObjectType } from '../../src/contracts/ontology/element.contract.ts';
import { getManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { approveProposal, mergeProposal, openBranch, submitProposal } from '../../src/contracts/ontology/proposal.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import { searchObjects, searchVocabulary } from '../../src/contracts/search/search.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as evaluatorService } from '../../src/routes/expression-evaluator/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import { service as searchService } from '../../src/routes/search/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, restManifest, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let api: Server;
let gateway: ServiceClient;
let root: Signed;
let editor: Signed;
let member: Signed;
let cleared: Signed;
let crm: string;
const types: Record<string, string> = {};
let hr: string;
const requests: string[] = [];

const COMPANIES = [
  { id: 'c1', name: 'Acme Holdings', reg_no: '01' }, { id: 'c2', name: 'Acme Logistics', reg_no: '02' },
  { id: 'c3', name: 'Globex', reg_no: '03' }, { id: 'c4', name: 'Initech', reg_no: '04' },
];
const CONTACTS = [{ id: 'p1', email: 'ada@acme.example', company_id: 'c1' }];

const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });

const outboxEvents = async (name: string): Promise<number> => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  `select count(*)::int as n from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2`,
  [cell.org, name]))).rows[0].n as number;

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url.pathname + url.search);
    const q = url.searchParams.get('q')?.toLowerCase();
    const results = url.pathname === '/v1/companies' ? COMPANIES.filter((c) => q === undefined || c.name.toLowerCase().includes(q))
      : url.pathname === '/v1/contacts' ? CONTACTS : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

  cell = await createConnectCell();
  await cell.start(evaluatorService, 'expression-evaluator', 'test_app');
  await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(ontologyService, 'ontology', 'test_app');
  await cell.start(searchService, 'search', 'test_app');
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  editor = await cell.member('editor@acme.example', 'Super admin');
  member = await cell.member('member@acme.example', 'Member');
  cleared = await cell.member('cleared@acme.example', 'Member');

  const source = (path: string) => ({ kind: 'rest', request: { method: 'GET', path, query: {} }, records: { jsonata: 'results' } });
  const connector = await gateway.call(createConnector, { body: { slug: 'crm', name: 'CRM', provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
  await gateway.call(createManifestVersion, {
    params: { connectorId: connector.id },
    body: {
      document: restManifest({
        baseUrl,
        objects: [
          { name: 'companies', identifier: ['id'], source: source('/v1/companies'),
            fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'name', type: 'string' }, { name: 'reg_no', type: 'string' }],
            pushdown: { filters: [{ field: 'name', ops: ['contains'], patch: { cel: '{"query": {"q": string(value)}}' } }] } },
          { name: 'contacts', identifier: ['id'], source: source('/v1/contacts'),
            fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'email', type: 'string' }, { name: 'company_id', type: 'string' }] },
        ],
      }),
    },
  }, keyed(root));
  let connection = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'CRM', owningScopeId: cell.scopes['engineering']! } },
    keyed(root));
  await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'secret-token' } } }, cell.as(root));
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(connection.id);
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } },
      cell.as(root));
  }
  crm = connection.id;

  const mapped = (object: string, field: string) => [{ connectionId: crm, sourceObject: object, fieldPath: field }];
  const branch = await gateway.call(openBranch, { body: { name: 'customers' } }, keyed(editor));
  await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'company' }, body: {
    displayName: 'Company', pluralName: 'Companies', description: 'An organisation we trade with',
    contributingObjects: [{ connectionId: crm, sourceObject: 'companies', identifierFieldPath: 'id' }],
    properties: [
      { apiName: 'company_id', displayName: 'Company id', dataType: 'string', mappings: mapped('companies', 'id') },
      { apiName: 'name', displayName: 'Name', dataType: 'string', mappings: mapped('companies', 'name') },
      { apiName: 'registration_number', displayName: 'Registration number', dataType: 'string', mappings: mapped('companies', 'reg_no') },
    ],
    primaryKey: 'company_id', title: 'name',
  } }, keyed(editor));
  await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'contact' }, body: {
    displayName: 'Contact', pluralName: 'Contacts',
    contributingObjects: [{ connectionId: crm, sourceObject: 'contacts', identifierFieldPath: 'id' }],
    properties: [
      { apiName: 'contact_id', displayName: 'Contact id', dataType: 'string', mappings: mapped('contacts', 'id') },
      { apiName: 'email', displayName: 'Email address', dataType: 'string', mappings: mapped('contacts', 'email') },
    ],
    primaryKey: 'contact_id', title: 'email',
  } }, keyed(editor));
  const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Customers' } }, keyed(editor));
  await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
  await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
  const main = await gateway.call(getManifest, { query: {} }, cell.as(root));
  for (const t of main.objectTypes) types[t.apiName] = t.id;

  hr = (await gateway.call(createMarking, { body: { name: 'HR confidential', kind: 'compartment' } }, cell.as(root))).id;
  await gateway.call(grantClearance, { body: { markingId: hr, holder: { kind: 'membership', id: cleared.membershipId } } }, cell.as(root));
  await gateway.call(applyMarking, { body: { markingId: hr, resource: { type: 'object_type', id: types['contact']! } } }, cell.as(root));
});

after(async () => {
  await cell?.close();
  api?.close();
});

const vocabulary = (who: Signed, text: string, extra: Record<string, unknown> = {}) =>
  gateway.call(searchVocabulary, { body: { text, ...extra } as never }, cell.as(who));

describe('ontology search (spec 24.5)', () => {
  test('names, plural names and api names match; best first, with what each hit belongs to', async () => {
    const found = await vocabulary(root, 'comp');
    assert.equal(found.method, 'ontology');
    assert.deepEqual(found.hits[0], {
      kind: 'object_type', id: types['company'], objectTypeId: null, apiName: 'company', displayName: 'Company',
      description: 'An organisation we trade with', score: 0.9,
    });
    const property = found.hits.find((h) => h.apiName === 'company_id')!;
    assert.equal(property.kind, 'property');
    assert.equal(property.objectTypeId, types['company']);
    const words = await vocabulary(root, 'registration num');
    assert.equal(words.hits[0]!.apiName, 'registration_number');
  });

  test('a near spelling still finds the type; a description is the weakest match', async () => {
    const typo = await vocabulary(root, 'compnay');
    assert.equal(typo.hits[0]!.apiName, 'company');
    assert.ok(typo.hits[0]!.score < 0.6);
    const described = await vocabulary(root, 'trade');
    assert.deepEqual(described.hits.map((h) => [h.apiName, h.score]), [['company', 0.2]]);
  });

  test('what the person\'s markings withhold does not exist for them: the type and its properties', async () => {
    assert.deepEqual((await vocabulary(member, 'contact')).hits, []);
    assert.deepEqual((await vocabulary(member, 'email')).hits, []);
    const seen = await vocabulary(cleared, 'contact');
    assert.deepEqual(seen.hits.map((h) => h.apiName).sort(), ['contact', 'contact_id']);
  });

  test('kinds and the limit narrow it; an Explorer search is audited, a Cmd-K search is not', async () => {
    const before = await outboxEvents('explorer_search_run');
    const onlyTypes = await vocabulary(root, 'c', { kinds: ['object_type'], limit: 1 });
    assert.deepEqual(onlyTypes.hits.map((h) => h.kind), ['object_type']);
    assert.equal(await outboxEvents('explorer_search_run'), before);
    await vocabulary(root, 'company', { surface: 'explorer' });
    assert.equal(await outboxEvents('explorer_search_run'), before + 1);
  });
});

const objects = (who: Signed, text: string, extra: Record<string, unknown> = {}) =>
  gateway.call(searchObjects, { body: { text, ...extra } as never }, cell.as(who));

describe('federated object search (spec 24.5, 33.5)', () => {
  test('the term is pushed to the source declaring a native filter on the title; one that cannot search is named', async () => {
    requests.length = 0;
    const found = await objects(cleared, 'acme');
    assert.equal(found.method, 'federated');
    // cleared holds no grant on the connection: nothing is read for them.
    assert.deepEqual(found.results, []);
    assert.ok(found.notSearched.every((n) => n.reason === 'no_access'));
    assert.equal(requests.length, 0, 'no source was called');

    const own = await objects(root, 'acme');
    assert.deepEqual(own.results.map((r) => [r.identifier, r.title]).sort(), [['c1', 'Acme Holdings'], ['c2', 'Acme Logistics']]);
    assert.ok(requests.some((r) => r.startsWith('/v1/companies') && r.includes('q=acme')), 'the filter ran at the source');
    assert.ok(!requests.some((r) => r.startsWith('/v1/contacts')), 'a source that cannot search is not read');
    assert.deepEqual(own.searched, [{ objectTypeId: types['company'], connectionId: crm, sourceObject: 'companies', matches: 2 }]);
    // root's markings do not reach the contact type either: it does not exist for them.
    assert.deepEqual(own.groups, [{ objectTypeId: types['company'], count: 2, exact: true, mergedByIdentity: true, route: 'federated', refreshedAt: null }]);
  });

  test('a type whose source cannot search is named, and its count is not exact', async () => {
    await gateway.call(grantClearance, { body: { markingId: hr, holder: { kind: 'membership', id: root.membershipId } } }, cell.as(root));
    const found = await objects(root, 'ada', { objectTypeIds: [types['contact']!] });
    assert.deepEqual(found.notSearched, [{ objectTypeId: types['contact'], connectionId: crm, sourceObject: 'contacts', reason: 'no_search_capability' }]);
    assert.deepEqual(found.groups, [{ objectTypeId: types['contact'], count: 0, exact: false, mergedByIdentity: true, route: 'federated', refreshedAt: null }]);
  });

  test('more matches than the bound is refused for that source, never truncated', async () => {
    const found = await objects(root, 'acme', { objectTypeIds: [types['company']!], perSourceLimit: 1 });
    assert.deepEqual(found.results, []);
    assert.deepEqual(found.notSearched, [{ objectTypeId: types['company'], connectionId: crm, sourceObject: 'companies', reason: 'over_bound' }]);
    assert.equal(found.groups[0]!.exact, false);
  });

  test('a title the person may not see is never matched for them', async () => {
    const titleRow = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select p.property_identity_id as id from ontology.properties p join ontology.object_types t on t.current_version_id = p.object_type_version_id
       where t.id = $1 and p.api_name = 'name'`, [types['company']]));
    const falcon = (await gateway.call(createMarking, { body: { name: 'Falcon', kind: 'compartment' } }, cell.as(root))).id;
    await gateway.call(applyMarking, { body: { markingId: falcon, resource: { type: 'property', id: titleRow.rows[0].id as string } } }, cell.as(root));
    requests.length = 0;
    const found = await objects(root, 'acme', { objectTypeIds: [types['company']!] });
    assert.deepEqual(found.notSearched, [{ objectTypeId: types['company'], connectionId: null, sourceObject: null, reason: 'withheld' }]);
    assert.equal(requests.length, 0);
    const vocab = await vocabulary(root, 'name', { kinds: ['property'] });
    assert.ok(!vocab.hits.some((h) => h.apiName === 'name'), 'nor found by its name');
  });
});
