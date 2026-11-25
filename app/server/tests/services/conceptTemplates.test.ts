// Concept templates (spec 22.7): a reviewed template whose field names a source object holds
// names its first proposal, says so in the evidence, and is recorded on the type once a person
// confirms it. A draft or withdrawn template is never read (row-level security), and a weak
// match names nothing.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { confirmDecisions, mergeProposal, startDerivation } from '../../src/contracts/ontology/proposal.contract.ts';
import { listFieldAliases, removeFieldAlias, setFieldAlias } from '../../src/contracts/ontology/fieldAlias.contract.ts';
import { modelVocabulary } from '../../src/services/compile/vocabulary.service.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { nameFor } from '../../src/services/ontology/templates.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

let api: Server;
let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let editor: Signed;
let books = '';
const invoiceTemplate = uuidv7();
const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });
const source = (path: string) => ({ kind: 'rest', request: { method: 'GET', path, query: {} }, records: { jsonata: 'results' } });

before(async () => {
  api = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"results":[]}'); });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  cell = await createConnectCell();
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(ontologyService, 'ontology', 'test_app');
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  editor = await cell.member('editor@acme.example', 'Super admin');
  // Fleet's reviewed set, written as the migration role (no tenant role may write it).
  const author = uuidv7();
  const reviewer = uuidv7();
  for (const [id, name, fields, status] of [
    [invoiceTemplate, 'Invoice', ['invoice_number', 'customer', 'total', 'currency'], 'reviewed'],
    [uuidv7(), 'Bill', ['invoice_number', 'customer', 'total'], 'draft'],
    [uuidv7(), 'Sales invoice', ['invoice_number', 'customer', 'total', 'due_date'], 'withdrawn'],
    [uuidv7(), 'Widget', ['colour', 'size', 'weight', 'sku'], 'reviewed'],
  ] as const) {
    await cell.migrate.query(
      `insert into ontology.concept_templates (id, name, field_names, authored_by, reviewed_by, reviewed_at, status)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, fields, author, status === 'reviewed' ? reviewer : null, status === 'reviewed' ? new Date().toISOString() : null, status]);
  }
  const connector = await gateway.call(createConnector, { body: { slug: 'books', name: 'books', provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: doc({
    schemaVersion: '1', identity: { name: 'Books', provider: 'Example', version: '1.0.0' },
    transport: { viaAgent: false, baseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}` }, protocol: { kind: 'rest' }, params: [],
    auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
    objects: [
      { name: 'inv_hdr', identifier: ['id'], source: source('/v1/inv'),
        fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'invoice_number', type: 'string' }, { name: 'customer', type: 'string' },
          { name: 'total', type: 'number' }, { name: 'due_date', type: 'date' }] },
      { name: 'widgets', identifier: ['id'], source: source('/v1/widgets'), fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'colour', type: 'string' }] },
    ],
  }) } }, keyed(root));
  let connection = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'books', owningScopeId: cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'tok_valid' } } }, cell.as(root));
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(connection.id);
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
  }
  books = connection.id;
});

after(async () => {
  await cell?.close();
  await new Promise<void>((resolve) => api?.close(() => resolve()));
});

describe('concept templates (22.7)', () => {
  test('matching: field names compared without case or separators; the highest share wins; too few names nothing', () => {
    const templates = [
      { id: 'a', name: 'Invoice', fieldNames: ['invoice_number', 'customer', 'total', 'currency'] },
      { id: 'b', name: 'Receipt', fieldNames: ['receipt_number', 'customer', 'total'] },
    ];
    assert.equal(nameFor(templates, ['InvoiceNumber', 'Customer', 'TOTAL'])?.template.name, 'Invoice', 'three of four beats two of three');
    assert.equal(nameFor(templates, ['customer', 'total'])?.template.name, 'Receipt', 'two of three beats two of four');
    assert.equal(nameFor(templates, ['customer']), undefined, 'one name is no match');
  });

  test('a reviewed template names the proposal and says so; drafts and withdrawn ones are never read; a weak match names nothing', async () => {
    const proposal = await gateway.call(startDerivation, { body: { connectionId: books, profile: false, overlap: false } }, keyed(editor));
    const types = proposal.decisions.filter((d) => d.kind === 'object_type');
    const invoice = types.find((d) => d.apiName === 'invoice')!;
    assert.ok(invoice, JSON.stringify(types.map((d) => d.apiName)));
    assert.equal(invoice.kind === 'object_type' && invoice.definition.displayName, 'Invoice');
    assert.equal(invoice.kind === 'object_type' && invoice.definition.pluralName, 'Invoices');
    assert.equal(invoice.kind === 'object_type' && invoice.templateId, invoiceTemplate, 'the reviewed Invoice, not the draft Bill or the withdrawn Sales invoice');
    assert.ok(invoice.evidence.some((e) => e.source === 'template' && e.detail === 'named by the concept template Invoice: 3 of its 4 field names are inv_hdr\'s'));
    const widgets = types.find((d) => d.apiName === 'widgets')!;
    assert.ok(widgets.kind === 'object_type' && widgets.templateId === undefined, 'one field name of four is no match');

    // Confirmed, the type keeps the template that named it.
    await gateway.call(confirmDecisions, { params: { proposalId: proposal.id }, body: { decisions: [{ decisionId: invoice.id, action: 'accept' }] } }, keyed(root));
    await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(`select template_id from ontology.object_types where api_name = 'invoice'`, []));
    assert.equal(rows[0].template_id, invoiceTemplate);
    const visible = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select name from ontology.concept_templates order by name', []));
    assert.deepEqual(visible.rows.map((r: { name: string }) => r.name), ['Invoice', 'Widget'], 'a tenant reads the reviewed set only');
  });
});

describe('field aliases (21.6)', () => {
  test('the organisation names a column once per connection: derivation names its properties by it, compile hears it, each change audited', async () => {
    const viewer = await cell.member('alias-viewer@acme.example', 'Member', 'engineering');
    const set = (fieldPath: string, alias: string, who: Signed = root) => gateway.call(setFieldAlias, { body: { connectionId: books, fieldPath, alias } }, cell.as(who));
    await assert.rejects(set('total', 'Amount due', viewer), { code: 'ontology.not_permitted' }, 'ontology.confirm');
    await assert.rejects(set('no_such_column', 'Anything'), { code: 'ontology.field_unknown' });
    const first = await set('total', 'Amount due');
    await assert.rejects(set('customer', 'amount due'), { code: 'ontology.alias_taken' }, 'one column per alias, whatever its case');
    const replaced = await set('total', 'Invoice total');
    assert.notEqual(replaced.id, first.id);
    assert.deepEqual((await gateway.call(listFieldAliases, { query: { connectionId: books } }, cell.as(viewer))).aliases.map((a) => [a.fieldPath, a.alias]),
      [['total', 'Invoice total']], 'the column\'s alias replaced; read by any member');

    const proposal = await gateway.call(startDerivation, { body: { connectionId: books, profile: false, overlap: false } }, keyed(editor));
    const invoice = proposal.decisions.find((d) => d.kind === 'object_type' && d.definition.contributingObjects[0]?.sourceObject === 'inv_hdr')!;
    const total = invoice.kind === 'object_type' ? invoice.definition.properties.find((p) => p.mappings[0]?.fieldPath === 'total') : undefined;
    assert.equal(total?.displayName, 'Invoice total', 'inherited by every type built over the connection');

    // Compile hears the alias as a name for every property mapped from the column, beside its own display name.
    const property = { apiName: 'amount', displayName: 'Amount', description: null, dataType: 'decimal', mappings: [{ connectionId: books, fieldPath: 'total' }] };
    const access = { manifest: { interfaces: [], sharedProperties: [] }, links: new Map(), interfaces: new Set(), fingerprint: '',
      types: new Map([['t', { type: { id: 't', apiName: 'invoice', displayName: 'Invoice', description: null, timeFields: [], implements: [] },
        properties: new Map([['p', { property, effect: 'allow' }]]), withheld: [] }]]) };
    const heard = modelVocabulary(access as never, new Map([[`${books}\u0000total`, 'Invoice total']]));
    assert.deepEqual(heard.objectTypes?.[0]?.properties?.[0]?.aliases, ['Invoice total']);

    assert.deepEqual(await gateway.call(removeFieldAlias, { params: { aliasId: replaced.id } }, cell.as(root)), { removed: true });
    assert.deepEqual(await gateway.call(removeFieldAlias, { params: { aliasId: replaced.id } }, cell.as(root)), { removed: false });
    const { rows } = await cell.migrate.query(
      `select payload->>'event' as event, payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' like 'field_alias_%' order by seq`, [cell.org]);
    assert.deepEqual(rows.map((r) => [r.event, r.detail.connection_id, r.detail.replaced_alias_id ?? null]),
      [['field_alias_set', books, null], ['field_alias_set', books, first.id], ['field_alias_removed', books, null]], 'each change audited, never the alias\'s words');
  });
});
