// The resolution service end to end (spec 23, 24.7, 24.8): a resolvable type over two
// systems; a run that writes the entity graph (keyed hashes only), resolves exactly, and
// proposes rules for what did not resolve (deterministic first, the model with key shapes and
// counts only); a reviewer who sees the pairs live and confirms, never the proposer; a
// confirmed rule re-keying the type with a redirect; the executor's call merging values under
// field authority with coverage; pair lists and splits.
// Real processes: credential, policy, auth, connect-registry, connect-runtime, ontology,
// model-gateway (against a fake model server) and resolution, against a fake source API.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setInferenceSettings } from '../../src/contracts/policy/inference.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { putObjectType } from '../../src/contracts/ontology/element.contract.ts';
import { getManifest, type ObjectTypeView } from '../../src/contracts/ontology/manifest.contract.ts';
import { approveProposal, mergeProposal, openBranch, submitProposal } from '../../src/contracts/ontology/proposal.contract.ts';
import { declareFieldAuthority, listFieldAuthorities, revokeFieldAuthority } from '../../src/contracts/resolution/authority.contract.ts';
import {
  confirmResolutionProposal, getResolutionRun, listResolutionProposals, previewResolutionProposal, proposePairs, proposeSplit,
  rejectResolutionProposal, startResolutionRun, type ResolutionRunView,
} from '../../src/contracts/resolution/proposal.contract.ts';
import { resolveRecords } from '../../src/contracts/resolution/resolve.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as modelGatewayService } from '../../src/routes/model-gateway/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { service as resolutionService } from '../../src/routes/resolution/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

// ----------------------------------------------------------------------------- the systems

const COMPANIES = [
  { id: 'c1', name: 'Acme Ltd', reg_no: ' 11111111 ', total: '100.00', status: 'P' },
  { id: 'c2', name: 'Beta', reg_no: '22-222-222', total: '50.5', status: 'D' },
  { id: 'c3', name: 'Gamma', reg_no: 'Q3001', total: '75', status: 'P' },
  { id: 'c4', name: 'Delta', reg_no: '44444444', total: '10', status: 'P' },
  { id: 'c5', name: 'No key', reg_no: null, total: '1', status: 'D' },
];
const CUSTOMERS = [
  { number: 'a1', trading_name: 'ACME LIMITED', reg_no: '11111111', total: '100' },
  { number: 'a2', trading_name: 'Beta', reg_no: '22222222', total: '50.50' },
  { number: 'a3', trading_name: 'Gamma', reg_no: '3001Q', total: '80' },
  { number: 'a4', trading_name: 'Epsilon', reg_no: '55555555', total: '5' },
];
const KEYS = ['11111111', '22222222', '22-222-222', '3001Q', 'Q3001', '44444444', '55555555'];

const MODEL_RULE = 'value.startsWith("Q") ? value.substring(1) + "Q" : value';

let api: Server;
let apiUrl: string;
let model: Server;
const modelRequests: string[] = [];

let cell: ConnectCell;
let gateway: ServiceClient;
let executor: ServiceClient;
let root: Signed;
let editor: Signed;
let viewer: Signed;
let crm: string;
let accounts: string;
let company: ObjectTypeView;
let versionId: string;
const prop = (apiName: string) => company.properties.find((p) => p.apiName === apiName)!.identityId;
const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });

const manifestFor = (objects: unknown[]) => doc({
  schemaVersion: '1', identity: { name: 'Source', provider: 'Example', version: '1.0.0' },
  transport: { viaAgent: false, baseUrl: apiUrl }, protocol: { kind: 'rest' }, params: [],
  auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
  objects,
});

async function activeConnection(slug: string, object: Record<string, unknown>): Promise<string> {
  const connector = await gateway.call(createConnector, { body: { slug, name: slug, provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifestFor([object]) } }, keyed(root));
  let connection = await gateway.call(createConnection, { body: { connectorId: connector.id, name: slug, owningScopeId: cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'tok_valid' } } }, cell.as(root));
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(connection.id);
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
  }
  return connection.id;
}

async function waitForRun(runId: string): Promise<ResolutionRunView> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const run = await gateway.call(getResolutionRun, { params: { runId } }, cell.as(root));
    if (run.status !== 'running') return run;
    if (Date.now() > deadline) assert.fail('the run did not finish');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const events = async (): Promise<{ event: string; detail: Record<string, unknown> }[]> => {
  const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `select payload->>'event' as event, payload->'detail' as detail from platform.outbox where organisation_id = $1 and event = 'audit_event'
     order by created_at, id`, [cell.org]));
  return rows as { event: string; detail: Record<string, unknown> }[];
};

const live = async () => {
  const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `select id, silo_object_id, connection_id, source_object, origin, resolution_proposal_id, octet_length(source_identifier_hash) as id_len,
       octet_length(match_key_hash) as key_len
     from ontology.match_keys where object_type_id = $1 and superseded_at is null`, [company.id]));
  return rows as { id: string; silo_object_id: string; connection_id: string; source_object: string; origin: string; resolution_proposal_id: string | null;
    id_len: number; key_len: number }[];
};

/** The rows a plan read, as the executor sends them. */
function sourcesFor(companies: readonly typeof COMPANIES[number][], customers: readonly typeof CUSTOMERS[number][], unchecked = false) {
  return [
    { connectionId: crm, sourceObject: 'companies', rows: companies.map((c) => ({
      identifier: c.id, values: { [prop('registration')]: c.reg_no, [prop('legal_name')]: c.name, [prop('total')]: c.total, [prop('status')]: c.status },
    })) },
    { connectionId: accounts, sourceObject: 'customers', unchecked, rows: customers.map((a) => ({
      identifier: a.number, values: { [prop('registration')]: a.reg_no, [prop('legal_name')]: a.trading_name, [prop('total')]: a.total },
    })) },
  ];
}

const resolve = (companies: readonly typeof COMPANIES[number][], customers: readonly typeof CUSTOMERS[number][], unchecked = false) =>
  executor.call(resolveRecords, { body: { objectTypeId: company.id, ontologyVersionId: versionId, sources: sourcesFor(companies, customers, unchecked) } },
    cell.as(root));

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer tok_valid') { res.statusCode = 401; res.end('{}'); return; }
    if (url.pathname === '/v1/companies') { res.end(JSON.stringify({ results: COMPANIES })); return; }
    if (url.pathname === '/v1/customers') { res.end(JSON.stringify({ results: CUSTOMERS })); return; }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  model = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      modelRequests.push(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'open-weights-test',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ rules: [
          { cel: MODEL_RULE, rationale: 'one system writes the letter first' },
          { cel: '"x"', rationale: 'everything is one' },
        ] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 20 },
      }));
    });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(path.join(tmpdir(), 'silo-resolution-'));
  const routes = path.join(dir, 'routes.json');
  writeFileSync(routes, JSON.stringify([{
    role: 'resolution', provider: 'self_hosted', endpoint: `http://127.0.0.1:${(model.address() as AddressInfo).port}`, model: 'open-weights-test',
    region: 'uk-lon-1', zeroRetention: true, maxOutputTokens: 1024,
  }]));

  cell = await createConnectCell();
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(ontologyService, 'ontology', 'test_app');
  await cell.start(modelGatewayService, 'model-gateway', 'test_model_gateway' as 'test_app', { MODEL_ROUTES_FILE: routes });
  await cell.start(resolutionService, 'resolution', 'test_app');
  gateway = cell.client('gateway');
  executor = cell.client('executor');
  root = await cell.signIn('root@acme.example');
  editor = await cell.member('editor@acme.example', 'Super admin');
  viewer = await cell.member('viewer@acme.example', 'Member');

  crm = await activeConnection('crm', {
    name: 'companies', identifier: ['id'],
    source: { kind: 'rest', request: { method: 'GET', path: '/v1/companies', query: {} }, records: { jsonata: 'results' } },
    fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'name', type: 'string' }, { name: 'reg_no', type: 'string' },
      { name: 'total', type: 'string' }, { name: 'status', type: 'string' }],
  });
  accounts = await activeConnection('accounts', {
    name: 'customers', identifier: ['number'],
    source: { kind: 'rest', request: { method: 'GET', path: '/v1/customers', query: {} }, records: { jsonata: 'results' } },
    fields: [{ name: 'number', type: 'string', nullable: false }, { name: 'trading_name', type: 'string' }, { name: 'reg_no', type: 'string' },
      { name: 'total', type: 'string' }],
  });

  // The type, on main: two systems, one match key, trimmed.
  const branch = await gateway.call(openBranch, { body: { name: 'companies' } }, keyed(editor));
  await gateway.call(putObjectType, {
    params: { branchId: branch.id, apiName: 'company' },
    body: {
      displayName: 'Company', pluralName: 'Companies',
      contributingObjects: [
        { connectionId: crm, sourceObject: 'companies', identifierFieldPath: 'id' },
        { connectionId: accounts, sourceObject: 'customers', identifierFieldPath: 'number' },
      ],
      properties: [
        { apiName: 'registration', displayName: 'Registration', dataType: 'string', mappings: [
          { connectionId: crm, sourceObject: 'companies', fieldPath: 'reg_no' }, { connectionId: accounts, sourceObject: 'customers', fieldPath: 'reg_no' }] },
        { apiName: 'legal_name', displayName: 'Legal name', dataType: 'string', mappings: [
          { connectionId: crm, sourceObject: 'companies', fieldPath: 'name' }, { connectionId: accounts, sourceObject: 'customers', fieldPath: 'trading_name' }] },
        { apiName: 'total', displayName: 'Total', dataType: 'decimal', typeParams: { scale: 2 }, mappings: [
          { connectionId: crm, sourceObject: 'companies', fieldPath: 'total' }, { connectionId: accounts, sourceObject: 'customers', fieldPath: 'total' }] },
        { apiName: 'status', displayName: 'Status', dataType: 'enum', typeParams: { values: ['posted', 'draft'] }, mappings: [
          { connectionId: crm, sourceObject: 'companies', fieldPath: 'status', valueMap: { P: 'posted', D: 'draft' } }] },
      ],
      title: 'legal_name', matchKeys: [{ property: 'registration', normalisation: 'value.trim()' }],
    },
  }, keyed(editor));
  const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Companies across two systems' } }, keyed(editor));
  await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
  await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
  const manifest = await gateway.call(getManifest, { query: {} }, cell.as(root));
  company = manifest.objectTypes.find((t) => t.apiName === 'company')!;
  versionId = manifest.version.id;
  assert.equal(company.resolutionClass, 'resolvable');
});

after(async () => {
  await cell?.close();
  api?.close();
  model?.close();
});

describe('a run over a resolvable type (spec 23.1 to 23.3)', () => {
  let run: ResolutionRunView;

  test('it writes the entity graph from both systems, exactly, as keyed hashes only', async () => {
    const started = await gateway.call(startResolutionRun, { body: { objectTypeId: company.id } }, keyed(editor));
    assert.equal(started.status, 'running');
    await assert.rejects(gateway.call(startResolutionRun, { body: { objectTypeId: company.id } }, keyed(viewer)), { code: 'resolution.not_permitted' });
    run = await waitForRun(started.id);
    assert.equal(run.status, 'completed', JSON.stringify(run.notes));
    assert.deepEqual(run.sources.map((s) => [s.sourceObject, s.records, s.unmatched]), [['companies', 5, 4], ['customers', 4, 3]]);
    assert.equal(run.unkeyed, 1, 'the company with no registration is its own object');
    assert.equal(run.objects, 8, 'c1 and a1 are one; every other record is its own');
    assert.equal(run.entries.added, 9);
    const rows = await live();
    assert.equal(rows.length, 9);
    assert.ok(rows.every((r) => r.id_len === 32 && r.key_len === 32 && r.origin === 'exact'));
    assert.equal(new Set(rows.map((r) => r.silo_object_id)).size, 8);
  });

  test('what did not resolve becomes proposals: a deterministic rule, then the model\'s, judged before they are proposed', async () => {
    assert.equal(run.proposals.length, 2);
    assert.equal(run.modelConsulted, true);
    assert.ok(run.notes.includes('model_rule_unsafe'), 'a rule that merges within one system is never proposed');
    const { proposals } = await gateway.call(listResolutionProposals, { query: { status: 'open' } }, cell.as(root));
    const byBasis = Object.fromEntries(proposals.map((p) => [p.proposal.kind === 'normalisation_rule' ? p.proposal.basis : 'other', p]));
    const deterministic = byBasis['deterministic']!;
    assert.equal(deterministic.proposal.kind === 'normalisation_rule' && deterministic.proposal.cel, 'value.split("-").join("")');
    assert.equal(deterministic.affectedCount, 1);
    assert.equal(deterministic.proposedByMembershipId, editor.membershipId);
    assert.equal(byBasis['model']!.proposal.kind === 'normalisation_rule' && byBasis['model']!.proposal.cel, MODEL_RULE);
    // The model saw shapes and counts, never a key.
    assert.equal(modelRequests.length, 1);
    for (const key of KEYS) assert.ok(!modelRequests[0]!.includes(key), `the model never sees ${key}`);
    assert.ok(modelRequests[0]!.includes('D8'), 'it sees the shape of an eight-digit key');
    const names = (await events()).map((e) => e.event);
    assert.ok(names.includes('resolution_run_started') && names.includes('resolution_run_completed'));
    assert.equal(names.filter((n) => n === 'resolution_proposed').length, 2);
  });

  test('a run of the same type again changes nothing and proposes nothing twice', async () => {
    const again = await waitForRun((await gateway.call(startResolutionRun, { body: { objectTypeId: company.id } }, keyed(editor))).id);
    assert.equal(again.status, 'completed');
    assert.deepEqual(again.entries, { added: 0, remapped: 0, merged: 0, retired: 0 });
    assert.deepEqual(again.proposals, [], 'the open rules are already waiting');
    assert.equal((await live()).length, 9);
  });
});

describe('deciding a proposal (spec 23.2, 24.8)', () => {
  test('the reviewer sees the actual pairs, read live; the proposer and a member without resolution.confirm cannot decide', async () => {
    const { proposals } = await gateway.call(listResolutionProposals, { query: { status: 'open' } }, cell.as(root));
    const rule = proposals.find((p) => p.proposal.kind === 'normalisation_rule' && p.proposal.basis === 'deterministic')!;
    const preview = await gateway.call(previewResolutionProposal, { params: { proposalId: rule.id }, body: {} }, cell.as(root));
    assert.equal(preview.total, 1);
    assert.deepEqual(preview.pairs[0]!.sides.map((s) => [s.sourceObject, s.identifier]).sort(), [['companies', 'c2'], ['customers', 'a2']]);
    await assert.rejects(gateway.call(confirmResolutionProposal, { params: { proposalId: rule.id } }, cell.as(editor)), { code: 'resolution.self_confirm' });
    await assert.rejects(gateway.call(confirmResolutionProposal, { params: { proposalId: rule.id } }, cell.as(viewer)), { code: 'resolution.not_permitted' });
  });

  test('a confirmed rule re-keys the type: the two objects become one, the other id redirects, naming the proposal', async () => {
    const before = await resolve([COMPANIES[1]!], [CUSTOMERS[1]!]);
    assert.equal(before.objects.length, 2, 'apart before the rule');
    const { proposals } = await gateway.call(listResolutionProposals, { query: { status: 'open' } }, cell.as(root));
    const rule = proposals.find((p) => p.proposal.kind === 'normalisation_rule' && p.proposal.basis === 'deterministic')!;
    const confirmed = await gateway.call(confirmResolutionProposal, { params: { proposalId: rule.id } }, cell.as(root));
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.decidedBy, root.membershipId);
    const run = await waitForRun(confirmed.runId!);
    assert.equal(run.status, 'completed', JSON.stringify(run.notes));
    assert.equal(run.entries.merged, 1);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select from_silo_object_id, to_silo_object_id, resolution_proposal_id from ontology.object_redirects where undone_at is null'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].resolution_proposal_id, rule.id);
    const ids = new Set(before.objects.map((o) => o.siloObjectId));
    assert.ok(ids.has(rows[0].from_silo_object_id) && ids.has(rows[0].to_silo_object_id), 'one of the two ids survives, the other redirects to it');

    const after = await resolve([COMPANIES[1]!], [CUSTOMERS[1]!]);
    assert.equal(after.objects.length, 1, 'one object now');
    assert.equal(after.objects[0]!.siloObjectId, rows[0].to_silo_object_id);
    assert.equal((await events()).filter((e) => e.event === 'resolution_confirmed').length, 1);
  });

  test('a rejected proposal stays rejected; deciding again is refused', async () => {
    const { proposals } = await gateway.call(listResolutionProposals, { query: { status: 'open' } }, cell.as(root));
    const modelRule = proposals.find((p) => p.proposal.kind === 'normalisation_rule' && p.proposal.basis === 'model')!;
    const rejected = await gateway.call(rejectResolutionProposal, { params: { proposalId: modelRule.id } }, cell.as(root));
    assert.equal(rejected.status, 'rejected');
    await assert.rejects(gateway.call(confirmResolutionProposal, { params: { proposalId: modelRule.id } }, cell.as(root)), { code: 'resolution.proposal_decided' });
  });
});

describe('the executor\'s call: identity, field authority and coverage (spec 23.4 to 23.6, 24.7)', () => {
  test('rows resolve to the objects the run recorded; values merge into agreed, disputed and only', async () => {
    const out = await resolve(COMPANIES.slice(0, 1), CUSTOMERS.slice(0, 1));
    assert.equal(out.objects.length, 1);
    const acme = out.objects[0]!;
    const recorded = (await live()).filter((r) => r.source_object === 'companies' || r.source_object === 'customers');
    assert.ok(recorded.some((r) => r.silo_object_id === acme.siloObjectId), 'the id the graph recorded, never recomputed');
    assert.deepEqual(acme.rows, [{ source: 0, row: 0 }, { source: 1, row: 0 }]);
    assert.deepEqual(acme.absentFrom, []);
    assert.deepEqual(acme.properties[prop('total')], { state: 'agreed', value: '100.00' }, '100.00 and 100 agree at scale 2');
    assert.deepEqual(acme.properties[prop('legal_name')], { state: 'disputed' }, 'no value at all when systems disagree');
    assert.deepEqual(acme.properties[prop('status')], { state: 'only', value: 'posted', from: crm }, 'after the value map');
    assert.equal(acme.properties[prop('registration')]!.state, 'disputed', 'the raw keys differ by the trim');
    assert.deepEqual(out.coverage.byProperty['total'], { population: 1, decided: 1, disputed: 0, empty: 0, unchecked: 0 });
    assert.equal(out.coverage.disputed, 1);
  });

  test('a declared authority turns the dispute into the winning system\'s value, naming the declaration', async () => {
    await assert.rejects(gateway.call(declareFieldAuthority, {
      body: { objectTypeId: company.id, propertyIdentityId: prop('status'), winningConnectionId: crm, reason: 'only one system' },
    }, keyed(root)), { code: 'resolution.authority_needless' });
    await assert.rejects(gateway.call(declareFieldAuthority, {
      body: { objectTypeId: company.id, propertyIdentityId: prop('legal_name'), winningConnectionId: accounts, reason: 'x', condition: 'object.' },
    }, keyed(root)), { code: 'resolution.condition_invalid' });
    await assert.rejects(gateway.call(declareFieldAuthority, {
      body: { objectTypeId: company.id, propertyIdentityId: prop('legal_name'), winningConnectionId: accounts, reason: 'the ledger is right' },
    }, keyed(viewer)), { code: 'resolution.not_permitted' });
    const authority = await gateway.call(declareFieldAuthority, {
      body: { objectTypeId: company.id, propertyIdentityId: prop('legal_name'), winningConnectionId: accounts, reason: 'the ledger holds the legal name' },
    }, keyed(root));
    assert.equal(authority.declaredBy, root.membershipId);
    assert.equal(authority.ontologyVersionId, versionId);
    const out = await resolve(COMPANIES.slice(0, 1), CUSTOMERS.slice(0, 1));
    assert.deepEqual(out.objects[0]!.properties[prop('legal_name')], {
      state: 'declared', value: 'ACME LIMITED', from: accounts, authorityId: authority.id,
    });
    // A condition: the CRM wins the total only where its status is posted.
    const conditional = await gateway.call(declareFieldAuthority, {
      body: { objectTypeId: company.id, propertyIdentityId: prop('total'), winningConnectionId: crm, condition: 'object.status == "P"',
        reason: 'posted totals are final in the CRM' },
    }, keyed(root));
    const gamma = await resolve([COMPANIES[2]!, COMPANIES[1]!], [CUSTOMERS[1]!]);
    const g = gamma.objects.find((o) => o.rows.some((r) => r.source === 0 && r.row === 0))!;
    assert.deepEqual(g.properties[prop('total')], { state: 'declared', value: '75', from: crm, authorityId: conditional.id }, 'posted: the CRM wins');
    const beta = gamma.objects.find((o) => o.rows.some((r) => r.source === 0 && r.row === 1))!;
    assert.deepEqual(beta.properties[prop('total')], { state: 'agreed', value: '50.5' }, 'draft: no declaration applies; 50.5 and 50.50 agree');
    const listed = await gateway.call(listFieldAuthorities, { query: { objectTypeId: company.id } }, cell.as(viewer));
    assert.equal(listed.authorities.length, 2);
    await gateway.call(revokeFieldAuthority, { params: { authorityId: conditional.id } }, cell.as(root));
    assert.equal((await gateway.call(listFieldAuthorities, { query: { objectTypeId: company.id } }, cell.as(root))).authorities.length, 1);
    const names = (await events()).map((e) => e.event);
    assert.equal(names.filter((n) => n === 'authority_declared').length, 2);
    assert.ok(names.includes('authority_revoked'));
  });

  test('a system that returned nothing for an object and could not be asked again leaves it unchecked, never settled', async () => {
    const out = await resolve([COMPANIES[3]!], [], true);
    const delta = out.objects[0]!;
    assert.deepEqual(delta.absentFrom, [{ connectionId: accounts, sourceObject: 'customers' }], 'the executor re-reads it by identity');
    assert.equal(delta.properties[prop('total')]!.state, 'unchecked');
    assert.equal(delta.properties[prop('status')]!.state, 'only', 'the other system does not map it');
    assert.equal(out.coverage.unchecked, 1);
    const recheck = (await events()).filter((e) => e.event === 'dispute_recheck_unavailable');
    assert.equal(recheck.length, 1);
    assert.deepEqual(recheck[0]!.detail, { objects: 1, sources: 1 });
    // Asked and absent: a reading of absence, so the CRM's total is the only one.
    const asked = await resolve([COMPANIES[3]!], []);
    assert.deepEqual(asked.objects[0]!.properties[prop('total')], { state: 'only', value: '10', from: crm });
  });

  test('a row with no key is its own object, and a source the type does not have is refused', async () => {
    const out = await resolve([COMPANIES[4]!], []);
    assert.equal(out.unkeyed, 1);
    assert.equal(out.objects.length, 1);
    await assert.rejects(executor.call(resolveRecords, {
      body: { objectTypeId: company.id, ontologyVersionId: versionId, sources: [{ connectionId: crm, sourceObject: 'contacts', rows: [] }] },
    }, cell.as(root)), { code: 'resolution.not_contributing' });
  });
});

describe('pair lists and splits (spec 23.2, 24.8)', () => {
  test('a confirmed pair list merges two objects as confirmed mappings; a confirmed split undoes it', async () => {
    const apart = await resolve([COMPANIES[2]!], [CUSTOMERS[2]!]);
    assert.equal(apart.objects.length, 2);
    const [gamma, gammaLedger] = apart.objects.map((o) => o.siloObjectId) as [string, string];
    await assert.rejects(gateway.call(proposePairs, { body: { objectTypeId: company.id, pairs: [{ from: gamma, to: gamma }] } }, keyed(editor)),
      { code: 'resolution.merge_self' });
    await assert.rejects(gateway.call(proposePairs, { body: { objectTypeId: company.id, pairs: [{ from: uuidv7(), to: gamma }] } }, keyed(editor)),
      { code: 'resolution.object_unknown' });
    const pairs = await gateway.call(proposePairs, { body: { objectTypeId: company.id, pairs: [{ from: gammaLedger, to: gamma }] } }, keyed(editor));
    const preview = await gateway.call(previewResolutionProposal, { params: { proposalId: pairs.id }, body: {} }, cell.as(root));
    assert.deepEqual(preview.pairs[0]!.sides.map((s) => s.identifier).sort(), ['a3', 'c3']);
    await gateway.call(confirmResolutionProposal, { params: { proposalId: pairs.id } }, cell.as(root));
    const together = await resolve([COMPANIES[2]!], [CUSTOMERS[2]!]);
    assert.equal(together.objects.length, 1);
    assert.equal(together.objects[0]!.siloObjectId, gamma);
    assert.deepEqual(together.objects[0]!.properties[prop('total')], { state: 'disputed' }, '75 and 80: no declaration now');
    const moved = (await live()).filter((r) => r.resolution_proposal_id === pairs.id);
    assert.equal(moved.length, 1);
    assert.equal(moved[0]!.origin, 'confirmed_mapping');

    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select id from ontology.object_redirects where from_silo_object_id = $1 and undone_at is null', [gammaLedger]));
    const split = await gateway.call(proposeSplit, { body: { redirectId: rows[0].id } }, keyed(editor));
    await gateway.call(confirmResolutionProposal, { params: { proposalId: split.id } }, cell.as(root));
    const again = await resolve([COMPANIES[2]!], [CUSTOMERS[2]!]);
    assert.deepEqual(again.objects.map((o) => o.siloObjectId).sort(), [gamma, gammaLedger].sort(), 'both ids back, each its own object');
    assert.ok((await events()).some((e) => e.event === 'object_split'));
  });

  test('only a merge confirmed from a pair list can be split', async () => {
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select r.id from ontology.object_redirects r join ontology.resolution_proposals p on p.id = r.resolution_proposal_id
       where p.kind = 'normalisation_rule' and r.undone_at is null`));
    await assert.rejects(gateway.call(proposeSplit, { body: { redirectId: rows[0].id } }, keyed(editor)), { code: 'resolution.split_unsupported' });
  });
});

describe('remapping when a record\'s key changes (spec 24.8)', () => {
  test('a record alone in its object keeps its id under a new key; moving onto another object\'s key redirects the emptied id', async () => {
    const before = await resolve([COMPANIES[3]!], []);
    const delta = before.objects[0]!.siloObjectId;
    const renumbered = await resolve([{ ...COMPANIES[3]!, reg_no: '66666666' }], []);
    assert.equal(renumbered.objects[0]!.siloObjectId, delta, 'the id is never recomputed');
    const epsilon = (await resolve([], [CUSTOMERS[3]!])).objects[0]!.siloObjectId;
    const moved = await resolve([{ ...COMPANIES[3]!, reg_no: '55555555' }], []);
    assert.equal(moved.objects[0]!.siloObjectId, epsilon, 'now the same thing as the ledger\'s record');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select to_silo_object_id from ontology.object_redirects where from_silo_object_id = $1 and undone_at is null', [delta]));
    assert.deepEqual(rows.map((r) => r.to_silo_object_id), [epsilon], 'references to the old id lead to where its record went');
    const remapped = (await events()).filter((e) => e.event === 'match_key_remapped');
    assert.ok(remapped.length >= 2);
  });
});

describe('inferred pairs, where the organisation turns resolution inference on (D74)', () => {
  test('records sharing no key but agreeing on the compared properties are proposed as a pair list; nothing merges', async () => {
    COMPANIES.push({ id: 'c9', name: 'Zeta Holdings', reg_no: 'Z-001', total: '12', status: 'P' } as never);
    CUSTOMERS.push({ number: 'a9', trading_name: 'zeta holdings', reg_no: '9999', total: '12' } as never);
    await gateway.call(setInferenceSettings, { body: { resolution: true } }, cell.as(root));
    try {
      const run = await waitForRun((await gateway.call(startResolutionRun, { body: { objectTypeId: company.id } }, keyed(editor))).id);
      assert.ok(run.notes.includes('inference_pairs:1'), run.notes.join(','));
      const { proposals } = await gateway.call(listResolutionProposals, { query: { status: 'open' } }, cell.as(root));
      const inferred = proposals.find((p) => p.proposal.kind === 'pair_list' && p.proposal.inference !== undefined)!;
      assert.ok(inferred, 'an inferred pair list waits for a person');
      const body = inferred.proposal as { pairs: unknown[]; inference: { fields: string[]; probabilities: number[]; agreement: (boolean | null)[][]; statement: string } };
      assert.equal(body.pairs.length, 1, 'Gamma, agreeing on its name but not its total, is not proposed');
      assert.deepEqual([...body.inference.fields].sort(), [prop('legal_name'), prop('total')].sort());
      assert.ok(body.inference.probabilities[0]! >= 0.9);
      assert.deepEqual(body.inference.agreement[0], [true, true]);
      assert.match(body.inference.statement, /Nothing merges until you confirm/);
      assert.equal(inferred.status, 'open');
    } finally {
      COMPANIES.pop();
      CUSTOMERS.pop();
      await gateway.call(setInferenceSettings, { body: { resolution: false } }, cell.as(root));
    }
  });
});
