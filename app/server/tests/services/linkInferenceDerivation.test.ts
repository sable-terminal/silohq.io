// Inferred links in derivation (decision 2026-11-11; D75): a system declares customers and
// orders but no key between them, though every order's customer_ref is a customer id. With the
// organisation's link inference off, derivation proposes no link; with it on, it proposes one,
// low in confidence's terms only as the evidence warrants, with the overlap as its evidence
// and its route marked inferred. Nothing exists until a person accepts it.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { startDerivation } from '../../src/contracts/ontology/proposal.contract.ts';
import { setInferenceSettings } from '../../src/contracts/policy/inference.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

const CUSTOMERS = Array.from({ length: 40 }, (_, i) => ({ id: `C${i + 1}`, name: `Customer ${i + 1}` }));
const ORDERS = Array.from({ length: 80 }, (_, i) => ({ id: `O${i + 1}`, customer_ref: `C${(i % 30) + 1}`, note: `N${i % 7}` }));

let api: Server;
let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let editor: Signed;
let crm = '';
const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });
const source = (path: string) => ({ kind: 'rest', request: { method: 'GET', path, query: {} }, records: { jsonata: 'results' } });

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer tok_valid') { res.statusCode = 401; res.end('{}'); return; }
    if (url.pathname === '/v1/customers') { res.end(JSON.stringify({ results: CUSTOMERS })); return; }
    if (url.pathname === '/v1/orders') { res.end(JSON.stringify({ results: ORDERS })); return; }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  cell = await createConnectCell();
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(ontologyService, 'ontology', 'test_app');
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  editor = await cell.member('editor@acme.example', 'Super admin');
  const connector = await gateway.call(createConnector, { body: { slug: 'shop', name: 'shop', provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: doc({
    schemaVersion: '1', identity: { name: 'Shop', provider: 'Example', version: '1.0.0' },
    transport: { viaAgent: false, baseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}` }, protocol: { kind: 'rest' }, params: [],
    auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
    objects: [
      { name: 'customers', identifier: ['id'], source: source('/v1/customers'),
        fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'name', type: 'string' }] },
      { name: 'orders', identifier: ['id'], source: source('/v1/orders'),
        fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'customer_ref', type: 'string' }, { name: 'note', type: 'string' }] },
    ],
  }) } }, keyed(root));
  let connection = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'shop', owningScopeId: cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'tok_valid' } } }, cell.as(root));
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(connection.id);
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
  }
  crm = connection.id;
});

after(async () => {
  await cell?.close();
  await new Promise<void>((resolve) => api?.close(() => resolve()));
});

describe('inferred links in derivation (D75)', () => {
  test('off: no key declared, no link proposed', async () => {
    const proposal = await gateway.call(startDerivation, { body: { connectionId: crm, profile: false } }, keyed(editor));
    assert.equal(proposal.decisions.filter((d) => d.kind === 'link_type').length, 0);
  });

  test('on: the overlap proposes a link, its route marked inferred, its evidence the counts', async () => {
    await gateway.call(setInferenceSettings, { body: { links: true } }, cell.as(root));
    try {
      const proposal = await gateway.call(startDerivation, { body: { connectionId: crm, profile: false } }, keyed(editor));
      const links = proposal.decisions.filter((d) => d.kind === 'link_type');
      assert.equal(links.length, 1, 'customer_ref only: the notes are no customer ids');
      const link = links[0]!;
      assert.equal(link.status, 'undecided', 'nothing exists until a person accepts it');
      assert.ok(link.confidence >= 0.9);
      const definition = link.definition as { routes: { sourceObject: string; foreignKeyField: string; referencedField: string; origin: string }[] };
      assert.deepEqual(definition.routes.map((r) => [r.sourceObject, r.foreignKeyField, r.referencedField, r.origin]), [['orders', 'customer_ref', 'id', 'inferred']]);
      assert.equal(link.evidence[0]!.source, 'overlap');
      assert.match(link.evidence[0]!.detail, /30 of 30 distinct orders\.customer_ref values are customers identifiers/);
    } finally {
      await gateway.call(setInferenceSettings, { body: { links: false } }, cell.as(root));
    }
  });
});
