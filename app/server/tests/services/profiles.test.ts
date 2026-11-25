// Field profiles (spec 22.1 to 22.3): connect-runtime reads a source object's values,
// bounded, and returns counts only; ontology stores them and derivation reads them. What
// this shows: the counts, an exact distinct count only when every row was examined, no
// value anywhere in what is stored or returned, an identifier confirmed unique or flagged,
// a title ranked by distinctness when no field is named for one, a field whose values do
// not read as its type flagged, and a source that cannot be profiled leaving derivation to
// the declared schema.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { profileObject } from '../../src/contracts/connect-runtime/profile.contract.ts';
import { listFieldProfiles, profileConnection } from '../../src/contracts/ontology/profile.contract.ts';
import { startDerivation } from '../../src/contracts/ontology/proposal.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { profileField } from '../../src/services/connect-runtime/profile.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

const PEOPLE = Array.from({ length: 8 }, (_, i) => ({
  id: `p${i}`, handle: `handle-${i}`, nickname: i % 3 === 0 ? null : i % 3 === 1 ? '' : `nick${i}`, age: i === 7 ? 'n/a' : 20 + i,
}));
const ORDERS = Array.from({ length: 30 }, (_, i) => ({ ref: `r${i % 4}`, note: 'x' }));

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let confirmer: Signed;
let api: Server;
let connectionId = '';
let broken = '';

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/v1/people') res.end(JSON.stringify({ results: PEOPLE }));
    else if (url.pathname === '/v1/orders') res.end(JSON.stringify({ results: ORDERS }));
    else { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  cell = await createConnectCell();
  // Ontology calls connect-runtime, so it starts after it.
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app', { EXECUTOR_MAX_ROWS_PER_SOURCE_STEP: '21' });
  await cell.start(ontologyService, 'ontology', 'test_app');
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  confirmer = await cell.member('confirm@acme.example', 'Super admin');
  const source = (path: string) => ({ kind: 'rest', request: { method: 'GET', path }, records: { jsonata: 'results' } });
  const connect = async (slug: string, objects: unknown[]) => {
    const keyed = { ...cell.as(root), idempotencyKey: uuidv7() };
    const connector = await gateway.call(createConnector, { body: { slug, name: slug, provider: 'Example', sourceRoute: 'visual' } }, keyed);
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: doc({
      schemaVersion: '1', identity: { name: slug, provider: 'Example', version: '1.0.0' }, transport: { viaAgent: false, baseUrl }, protocol: { kind: 'rest' },
      auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] }, objects,
    }) } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    const connection = await gateway.call(createConnection, {
      body: { connectorId: connector.id, name: slug, owningScopeId: cell.scopes['engineering']! },
    }, { ...cell.as(root), idempotencyKey: uuidv7() });
    await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 't' } } }, cell.as(root));
    await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move: 'probe', version: connection.version } }, cell.as(root));
    return connection.id;
  };
  connectionId = await connect('people-crm', [
    { name: 'people', identifier: ['id'], source: source('/v1/people'),
      fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'handle', type: 'string' }, { name: 'nickname', type: 'string' }, { name: 'age', type: 'integer' }] },
    { name: 'orders', identifier: ['ref'], source: source('/v1/orders'), fields: [{ name: 'ref', type: 'string' }, { name: 'note', type: 'string' }] },
  ]);
  broken = await connect('broken-crm', [
    { name: 'things', identifier: ['id'], source: source('/v1/missing'), fields: [{ name: 'id', type: 'string' }, { name: 'label', type: 'string' }] },
  ]);
});

after(async () => {
  await cell?.close();
  api?.close();
});

describe('field profiles (spec 22.3)', () => {
  test('counts, and an exact distinct count only over every row', () => {
    const values = ['a', 'b', 'b', null, '', 'cc'];
    assert.deepEqual(profileField('f', 'string', values, true), {
      field: 'f', rowCount: 6, distinctCount: 4, nullCount: 1, emptyCount: 1, minLength: 0, maxLength: 2, typeConformanceCount: 5,
    });
    assert.equal(profileField('f', 'string', values, false).distinctCount, null, 'part of an object: never estimated');
    assert.equal(profileField('n', 'integer', [1, '2', 'n/a', 3.5, null], true).typeConformanceCount, 2);
  });

  test('connect-runtime returns counts only; past the bound the distinct count is absent', async () => {
    const people = await cell.client('ontology').call(profileObject, { body: { connectionId, object: 'people', reason: 'probe' } }, cell.as(root));
    assert.equal(people.complete, true);
    const byField = new Map(people.fields.map((f) => [f.field, f]));
    assert.deepEqual([byField.get('id')!.distinctCount, byField.get('id')!.rowCount], [8, 8]);
    assert.deepEqual([byField.get('nickname')!.nullCount, byField.get('nickname')!.emptyCount], [3, 3]);
    assert.equal(byField.get('age')!.typeConformanceCount, 7);
    assert.ok(!JSON.stringify(people).includes('handle-'), 'no value leaves');
    const orders = await cell.client('ontology').call(profileObject, { body: { connectionId, object: 'orders', reason: 'probe' } }, cell.as(root));
    assert.deepEqual([orders.complete, orders.rowsExamined, orders.fields[0]!.distinctCount], [false, 20, null]);
  });

  test('derivation profiles first: an identifier confirmed or flagged, a title ranked, a stray type flagged', async () => {
    const proposal = await gateway.call(startDerivation, { body: { connectionId } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    const people = proposal.decisions.find((d) => d.kind === 'object_type' && d.apiName.startsWith('people'))!;
    const details = people.evidence.map((e) => e.detail);
    assert.ok(details.includes('identifier id: unique and never null across all 8 rows'), details.join('\n'));
    assert.ok(details.includes('title handle: the most distinct, least empty text field'));
    assert.ok(details.includes('age: 1 of 8 values do not read as integer'));
    assert.equal(people.kind === 'object_type' && people.definition.title, 'handle');
    assert.ok(people.confidence <= 0.7);
    const orders = proposal.decisions.find((d) => d.kind === 'object_type' && d.apiName.startsWith('orders'))!;
    assert.ok(orders.evidence.some((e) => e.detail === 'identifier ref: 20 rows examined of more, 0 null; uniqueness unchecked'));
    const stored = await gateway.call(listFieldProfiles, { params: { connectionId } }, cell.as(confirmer));
    assert.equal(stored.profiles.length, 6);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select count(*)::int as n from platform.outbox where payload->>'event' = 'field_profiled' and organisation_id = $1`, [cell.org]));
    assert.ok(rows[0]!.n >= 2);

    // Profiled again: the latest stays one per field; depth 2 also gives the one before, newest first (drift, 51.11).
    await gateway.call(profileConnection, { params: { connectionId }, body: {} }, cell.as(root));
    assert.equal((await gateway.call(listFieldProfiles, { params: { connectionId } }, cell.as(confirmer))).profiles.length, 6);
    const two = (await gateway.call(listFieldProfiles, { params: { connectionId }, query: { depth: 2 } }, cell.as(confirmer))).profiles;
    assert.equal(two.length, 12);
    for (let i = 0; i < two.length; i += 2) {
      assert.equal(`${two[i]!.sourceObject}.${two[i]!.fieldPath}`, `${two[i + 1]!.sourceObject}.${two[i + 1]!.fieldPath}`);
      assert.ok(two[i]!.profiledAt > two[i + 1]!.profiledAt, 'newest first per field');
    }
  });

  test('a source that cannot be profiled leaves derivation to the declared schema', async () => {
    const result = await gateway.call(profileConnection, { params: { connectionId: broken }, body: {} }, cell.as(root));
    assert.deepEqual(result.profiled, []);
    assert.equal(result.failed[0]!.object, 'things');
    const proposal = await gateway.call(startDerivation, { body: { connectionId: broken } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    assert.ok(proposal.decisions[0]!.evidence.some((e) => e.detail === 'things not profiled: the evidence is the declared schema'));
  });
});
