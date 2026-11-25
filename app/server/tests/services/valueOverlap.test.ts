// Value overlap in derivation (spec 22.4): a CRM's customers are confirmed as a type; a billing
// system's accounts hold many of the same email addresses. Deriving the billing system then
// proposes, beside its own types, the accounts contributing to customers, matched on email,
// with the counts as evidence; its leads, whose addresses the CRM does not hold, propose
// nothing. Accepted, customers becomes resolvable. Only counts are recorded.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { getManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { approveProposal, confirmDecisions, mergeProposal, startDerivation } from '../../src/contracts/ontology/proposal.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { candidatePairs, judgeOverlap } from '../../src/services/ontology/overlap.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

const CUSTOMERS = Array.from({ length: 40 }, (_, i) => ({ id: `C${i + 1}`, name: `Customer ${i + 1}`, email: `p${i + 1}@acme.test` }));
const ACCOUNTS = Array.from({ length: 30 }, (_, i) => ({ acct: `A${i + 1}`, company: `Co ${i + 1}`, email: `p${i + 11}@acme.test` }));
const LEADS = Array.from({ length: 25 }, (_, i) => ({ id: `L${i + 1}`, email: `x${i + 1}@elsewhere.test` }));

let api: Server;
let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let editor: Signed;
let crm = '';
let billing = '';
const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });
const source = (path: string) => ({ kind: 'rest', request: { method: 'GET', path, query: {} }, records: { jsonata: 'results' } });

async function connect(slug: string, objects: unknown[]): Promise<string> {
  const connector = await gateway.call(createConnector, { body: { slug, name: slug, provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: doc({
    schemaVersion: '1', identity: { name: slug, provider: 'Example', version: '1.0.0' },
    transport: { viaAgent: false, baseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}` }, protocol: { kind: 'rest' }, params: [],
    auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] }, objects,
  }) } }, keyed(root));
  let connection = await gateway.call(createConnection, { body: { connectorId: connector.id, name: slug, owningScopeId: cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'tok_valid' } } }, cell.as(root));
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(connection.id);
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
  }
  return connection.id;
}

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer tok_valid') { res.statusCode = 401; res.end('{}'); return; }
    const rows: Record<string, unknown[]> = { '/v1/customers': CUSTOMERS, '/v1/accounts': ACCOUNTS, '/v1/leads': LEADS };
    if (rows[url.pathname] === undefined) { res.statusCode = 404; res.end('{}'); return; }
    res.end(JSON.stringify({ results: rows[url.pathname] }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  cell = await createConnectCell();
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(ontologyService, 'ontology', 'test_app');
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  editor = await cell.member('editor@acme.example', 'Super admin');
  crm = await connect('crm', [{ name: 'customers', identifier: ['id'], source: source('/v1/customers'),
    fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'name', type: 'string' }, { name: 'email', type: 'string' }] }]);
  billing = await connect('billing', [
    { name: 'accounts', identifier: ['acct'], source: source('/v1/accounts'),
      fields: [{ name: 'acct', type: 'string', nullable: false }, { name: 'company', type: 'string' }, { name: 'email', type: 'string' }] },
    { name: 'leads', identifier: ['id'], source: source('/v1/leads'), fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'email', type: 'string' }] },
  ]);
  // The CRM's customers, confirmed as a type on main.
  const first = await gateway.call(startDerivation, { body: { connectionId: crm, profile: false } }, keyed(editor));
  const customers = first.decisions.find((d) => d.kind === 'object_type' && d.apiName === 'customers')!;
  await gateway.call(confirmDecisions, { params: { proposalId: first.id }, body: { decisions: [{ decisionId: customers.id, action: 'accept' }] } }, keyed(root));
  await gateway.call(mergeProposal, { params: { proposalId: first.id } }, keyed(root));
});

after(async () => {
  await cell?.close();
  await new Promise<void>((resolve) => api?.close(() => resolve()));
});

describe('value overlap (22.4)', () => {
  test('the judgement: enough shared, and credibly a fifth or more of those sampled; below it, nothing', () => {
    assert.ok(judgeOverlap(30, 30)! >= 0.9);
    assert.equal(judgeOverlap(30, 9), undefined, 'fewer than ten shared');
    assert.equal(judgeOverlap(1_000, 12), undefined, 'a handful in a thousand is chance');
  });

  test('a field holding many of another system\'s identities proposes joining that type, matched on it; the rest propose nothing', async () => {
    const proposal = await gateway.call(startDerivation, { body: { connectionId: billing, profile: false } }, keyed(editor));
    const joins = proposal.decisions.filter((d) => d.kind === 'object_type' && d.apiName === 'customers');
    assert.equal(joins.length, 1, 'accounts only: the leads\' addresses are not the CRM\'s');
    const join = joins[0]!;
    assert.equal(join.status, 'undecided');
    assert.ok(join.confidence >= 0.9);
    assert.equal(join.evidence[0]!.source, 'overlap');
    assert.match(join.evidence[0]!.detail, /^30 of 30 distinct accounts\.email values are held in customers\.email/);
    const definition = join.kind === 'object_type' ? join.definition : undefined;
    assert.deepEqual(definition!.contributingObjects.map((c) => [c.connectionId === crm ? 'crm' : 'billing', c.sourceObject, c.identifierFieldPath]),
      [['crm', 'customers', 'id'], ['billing', 'accounts', 'acct']]);
    assert.deepEqual(definition!.matchKeys, [{ property: 'email' }]);
    assert.deepEqual(definition!.properties.find((p) => p.apiName === 'email')!.mappings.map((m) => m.sourceObject), ['customers', 'accounts']);
    assert.ok(proposal.decisions.some((d) => d.kind === 'object_type' && d.apiName === 'accounts'), 'its own type is still proposed');

    // Counts only.
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload->'detail' as detail from platform.outbox where payload->>'event' = 'overlap_computed' order by created_at`, []));
    assert.deepEqual(rows.map((r: { detail: Record<string, unknown> }) => r.detail), [
      { object: 'accounts', field: 'email', object_type: 'customers', property: 'email', sampled: 30, shared: 30 },
    ]);

    // Accepted, customers is fed by both systems and resolved on email.
    const confirmed = await gateway.call(confirmDecisions, { params: { proposalId: proposal.id }, body: { decisions: [{ decisionId: join.id, action: 'accept' }] } }, keyed(root));
    // A change to an existing type also needs ontology.manage (spec 25.4).
    if (confirmed.proposal.status !== 'approved') {
      await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.manage' } }, cell.as(root));
    }
    await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
    const manifest = await gateway.call(getManifest, { query: {} }, cell.as(root));
    const customers = manifest.objectTypes.find((t) => t.apiName === 'customers')!;
    assert.equal(customers.resolutionClass, 'resolvable');
    const email = customers.properties.find((p) => p.apiName === 'email')!;
    assert.deepEqual(customers.matchKeys.map((k) => k.propertyIdentityId), [email.identityId]);
  });

  test('a type already joined is not proposed again; overlap off proposes nothing', async () => {
    const again = await gateway.call(startDerivation, { body: { connectionId: billing, profile: false } }, keyed(editor));
    assert.equal(again.decisions.filter((d) => d.apiName === 'customers').length, 0, 'accounts already contributes');
    const off = await gateway.call(startDerivation, { body: { connectionId: billing, profile: false, overlap: false } }, keyed(editor));
    assert.equal(off.decisions.filter((d) => d.apiName === 'customers').length, 0);
    assert.equal(candidatePairs({ connectionId: crm, connectionName: 'crm', connectorVersion: '1.0.0', objects: [] },
      { objectTypes: [], linkTypes: [], sharedProperties: [], interfaces: [], functions: [] }).length, 0);
  });
});
