// schema-inference (spec 14.6, 16.3): a connection's structure read from the live source as
// probes through connect-runtime, with confidence and counted evidence, and never a record
// value kept. REST against a fake API that wraps its records in an envelope; SQL against a
// throwaway database read through a fake Silo Agent, by its information_schema.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { inferConnection } from '../../src/contracts/schema-inference/inference.contract.ts';
import { DEFAULT_ADMIN_URL, urlFor } from '../../src/db/scripts/bootstrapLocal.script.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as inferenceService } from '../../src/routes/schema-inference/index.route.ts';
import { SourceSqlError, type AgentChannel } from '../../src/services/connect-runtime/agent.service.ts';
import {
  catalogueType, findRecords, inferFields, inferIdentifier, inferRelationships, pagingHints, toName,
} from '../../src/services/schema-inference/infer.service.ts';
import { catalogueObjects, rawObject } from '../../src/services/schema-inference/probeManifest.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

const CUSTOMERS = [
  { id: 'c1', name: 'Acme Ltd', contact: { email: 'buyer@acme.example', phone: null }, created: '2026-01-04T09:00:00Z', tier: 2 },
  { id: 'c2', name: 'Brill', contact: { email: 'ops@brill.example', phone: '01632 960001' }, created: '2026-02-11T10:30:00Z', tier: 1 },
  { id: 'c3', name: 'Cobalt', contact: { email: 'hi@cobalt.example', phone: null }, created: '2026-03-01T08:15:00Z', tier: 3 },
];
const INVOICES = [
  { id: 101, customer_id: 'c1', total: 120.5, issued: '2026-04-01', paid: true },
  { id: 102, customer_id: 'c2', total: 80, issued: '2026-04-03', paid: false },
  { id: 103, customer_id: 'c1', total: 15.25, issued: '2026-04-09', paid: false },
  { id: 104, customer_id: 'c9', total: 42, issued: '2026-04-10', paid: true },
];

let api: Server;
let apiUrl: string;
let cell: ConnectCell;
let root: Signed;
let customer: pg.Client;
const customerDb = `silo_test_shop_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer tok_ok') { res.statusCode = 401; res.end('{"error":"unauthorised"}'); return; }
    if (url.pathname === '/v2/customers') { res.end(JSON.stringify({ data: CUSTOMERS, meta: { next_cursor: 'abc', total: 3 } })); return; }
    if (url.pathname === '/v2/invoices') { res.end(JSON.stringify(INVOICES)); return; }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const admin = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${customerDb}`);
  await admin.end();
  customer = new pg.Client({ connectionString: urlFor(DEFAULT_ADMIN_URL, customerDb) });
  await customer.connect();
  await customer.query(`
    create schema shop;
    create table shop.customers (id integer primary key, name text not null, joined date, vip boolean default false);
    create table shop.orders (id bigint primary key, customer_id integer not null references shop.customers (id),
      amount numeric(12,2) not null, placed_at timestamptz not null, notes jsonb);
    insert into shop.customers values (1, 'Acme', '2026-01-01', true);`);

  cell = await createConnectCell();
  const agent: AgentChannel = {
    async query(input) {
      try {
        const result = await customer.query({ text: input.statement.text, values: input.statement.values });
        return { rows: result.rows.slice(0, input.maxRows) };
      } catch (error) {
        throw new SourceSqlError(String((error as { code?: string }).code ?? 'XX000'));
      }
    },
  };
  await cell.start(createConnectRuntimeService({ agent }), 'connect-runtime', 'test_app');
  await cell.start(inferenceService, 'schema-inference', 'test_app');
  root = await cell.signIn('root@acme.example');
});

after(async () => {
  await cell?.close();
  api?.close();
  await customer?.end();
  const admin = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${customerDb} with (force)`);
  await admin.end();
});

/** A private connector, one version and a probing connection, as a build route makes them. */
async function probing(document: Record<string, unknown>, secrets: Record<string, string>, agentPoolId?: string): Promise<string> {
  const gateway = cell.client('gateway');
  const key = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
  const connector = await gateway.call(createConnector, { body: { slug: `p-${uuidv7().slice(-12)}`, name: 'Probe', provider: 'Example', sourceRoute: 'visual' } }, key());
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: doc(document) } }, key());
  let connection = await gateway.call(createConnection, {
    body: { connectorId: connector.id, name: 'Probe', owningScopeId: cell.scopes['engineering']!, ...(agentPoolId ? { agentPoolId } : {}) },
  }, key());
  if (Object.keys(secrets).length > 0) await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: secrets } }, cell.as(root));
  connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move: 'probe', version: connection.version } }, cell.as(root));
  return connection.id;
}

const restProbe = (objects: unknown[]) => ({
  schemaVersion: '1', identity: { name: 'Shop API', provider: 'Example', version: '0.0.1-draft.1' },
  transport: { viaAgent: false, baseUrl: apiUrl }, protocol: { kind: 'rest' },
  auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'Token', role: 'token' }] },
  objects,
});

describe('inference over records, in memory (spec 14.6)', () => {
  test('the records sit in the envelope\'s longest array of objects; a bare array is the records', () => {
    const wrapped = findRecords([{ data: CUSTOMERS, meta: { next_cursor: 'x' }, tags: [{ a: 1 }] }]);
    assert.equal(wrapped.recordsPath, 'data');
    assert.equal(wrapped.records.length, 3);
    assert.deepEqual(pagingHints(wrapped.envelope).map((h) => [h.style, h.path]), [['cursor', 'meta.next_cursor']]);
    assert.equal(findRecords(INVOICES).recordsPath, '$');
    assert.deepEqual(pagingHints({ links: { next: 'https://api.example/v1/x?page=2' }, total_pages: 4 }).map((h) => h.style).sort(), ['next_url', 'page']);
  });

  test('types on the lattice, formats detected, nested paths flattened, maps kept whole', () => {
    const { fields } = inferFields([
      ...CUSTOMERS.map((c) => ({ ...c, scores: { '123456': 1, '234567': 2, '345678': 3 } })),
    ]);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    assert.equal(byName['id']!.type, 'string');
    assert.equal(byName['tier']!.type, 'integer');
    assert.equal(byName['created']!.type, 'date-time');
    assert.equal(byName['contact_email']!.path, 'contact.email');
    assert.equal(byName['contact_email']!.format, 'email');
    assert.equal(byName['contact_phone']!.nullable, true);
    assert.equal(byName['scores']!.type, 'json', 'keys that look like identifiers are values: a map, not fields');
    assert.equal(Object.keys(byName).some((n) => n.startsWith('scores_')), false);
    assert.deepEqual(byName['tier']!.evidence, { sampled: 3, present: 3, nulls: 0, distinct: 3, types: { integer: 3 } });
    const mixed = inferFields([{ v: 1 }, { v: 2.5 }, { v: null }]).fields[0]!;
    assert.equal(mixed.type, 'number');
    assert.equal(toName('totalAmountGBP'), 'total_amount_gbp');
    assert.equal(toName('1st'), 'f_1st');
  });

  test('the identifier is unique and present in every record; relationships by name and counted overlap', () => {
    const customers = inferFields(CUSTOMERS);
    const invoices = inferFields(INVOICES);
    const cid = inferIdentifier('customers', customers.fields, 3)!;
    assert.deepEqual(cid.fields, ['id']);
    assert.ok(cid.confidence > 0.5);
    assert.equal(inferIdentifier('things', inferFields([{ a: 1 }, { a: 1 }]).fields, 2), null, 'not unique: no identifier');
    const rel = inferRelationships([
      { name: 'customers', identifier: 'id', fields: customers.fields, values: customers.values },
      { name: 'invoices', identifier: 'id', fields: invoices.fields, values: invoices.values },
    ]).get('invoices')!;
    assert.equal(rel.length, 1);
    assert.deepEqual({ ...rel[0], confidence: undefined }, {
      field: 'customer_id', targetObject: 'customers', targetField: 'id', kind: 'foreign_key', confidence: undefined,
      evidence: { declared: false, checked: 4, matched: 3 },
    });
    assert.equal(rel[0]!.confidence, 0.88);
  });

  test('standard catalogue types map onto the lattice', () => {
    assert.deepEqual(['integer', 'bigint', 'numeric', 'double precision', 'boolean', 'date', 'timestamp with time zone', 'jsonb', 'text', 'character varying']
      .map(catalogueType), ['integer', 'integer', 'number', 'number', 'boolean', 'date', 'date-time', 'json', 'string', 'string']);
  });
});

describe('a REST connection, probed through connect-runtime', () => {
  test('objects, records path, fields, identifier, relationships and paging, with counts and never values', async () => {
    const connectionId = await probing(restProbe([
      rawObject('customers', { method: 'GET', path: '/v2/customers', query: {}, headers: {} }),
      rawObject('invoices', { method: 'GET', path: '/v2/invoices', query: {}, headers: {} }),
      rawObject('missing', { method: 'GET', path: '/v2/nothing', query: {}, headers: {} }),
    ]), { token: 'tok_ok' });
    const out = await cell.client('connector-builder').call(inferConnection, { body: { connectionId, sampleSize: 50 } }, cell.as(root));
    assert.equal(out.schema.mode, 'records');
    const customers = out.schema.objects.find((o) => o.name === 'customers')!;
    assert.equal(customers.recordsPath, 'data');
    assert.equal(customers.sampled, 3);
    assert.deepEqual(customers.identifier?.fields, ['id']);
    assert.deepEqual(customers.paging.map((p) => p.path), ['meta.next_cursor']);
    const invoices = out.schema.objects.find((o) => o.name === 'invoices')!;
    assert.equal(invoices.recordsPath, '$');
    assert.equal(invoices.fields.find((f) => f.name === 'issued')!.type, 'date');
    assert.equal(invoices.fields.find((f) => f.name === 'total')!.type, 'number');
    assert.deepEqual(invoices.relationships.map((r) => [r.field, r.targetObject, r.evidence.matched]), [['customer_id', 'customers', 3]]);
    assert.deepEqual(out.failures, [{ object: 'missing', code: 'source.not_found', meaning: 'not_found' }]);

    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select stage, status, findings::text as findings, errors from connect.probe_runs where id = $1', [out.probeRunId]));
    assert.equal(rows[0].stage, 'probe');
    assert.equal(rows[0].status, 'completed');
    for (const value of ['Acme Ltd', 'buyer@acme.example', '01632', 'c9', '120.5']) {
      assert.equal((rows[0].findings as string).includes(value), false, `the probe run keeps no value (${value})`);
    }
    const { rows: events } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload->>'event' as event from platform.outbox where organisation_id = $1 and payload->>'event' like 'probe_%' order by created_at, id`,
      [cell.org]));
    assert.deepEqual(events.map((e) => e.event).slice(-2), ['probe_started', 'probe_completed']);
  });

  test('a source that refuses the credential fails the probe by stage and meaning', async () => {
    const connectionId = await probing(restProbe([rawObject('customers', { method: 'GET', path: '/v2/customers', query: {}, headers: {} })]),
      { token: 'tok_wrong' });
    const out = await cell.client('connector-builder').call(inferConnection, { body: { connectionId } }, cell.as(root));
    assert.deepEqual(out.schema.objects, []);
    assert.deepEqual(out.failures, [{ object: 'customers', code: 'source.auth', meaning: 'auth' }]);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select status from connect.probe_runs where id = $1', [out.probeRunId]));
    assert.equal(rows[0].status, 'failed');
  });

  test('only the owner, or connection.manage where it is owned, may probe', async () => {
    const connectionId = await probing(restProbe([rawObject('customers', { method: 'GET', path: '/v2/customers', query: {}, headers: {} })]),
      { token: 'tok_ok' });
    const member = await cell.member('member@acme.example', 'Member');
    await assert.rejects(cell.client('connector-builder').call(inferConnection, { body: { connectionId } }, cell.as(member)),
      { code: 'inference.not_permitted' });
  });
});

describe('a SQL connection, by its information_schema (catalogue mode)', () => {
  test('tables, columns, types, primary keys and declared foreign keys, at confidence 1', async () => {
    const pool = uuidv7();
    await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `insert into connect.agent_pools (id, organisation_id, name, created_by) values ($1, $2, 'Office', $3)`, [pool, cell.org, root.membershipId]));
    const connectionId = await probing({
      schemaVersion: '1', identity: { name: 'Shop database', provider: 'Example', version: '0.0.1-draft.1' },
      transport: { viaAgent: true }, protocol: { kind: 'sql', dialect: 'postgres' },
      auth: { strategy: 'none' }, objects: catalogueObjects(),
    }, {}, pool);
    const out = await cell.client('connector-builder').call(inferConnection, { body: { connectionId, schemas: ['shop'] } }, cell.as(root));
    assert.equal(out.schema.mode, 'catalogue');
    assert.deepEqual(out.failures, []);
    assert.deepEqual(out.schema.objects.map((o) => o.name), ['customers', 'orders']);
    const orders = out.schema.objects.find((o) => o.name === 'orders')!;
    assert.deepEqual(orders.table, { schema: 'shop', table: 'orders' });
    assert.deepEqual(orders.identifier, { fields: ['id'], confidence: 1, evidence: { unique: 0, nonNull: 0 } });
    assert.deepEqual(orders.fields.map((f) => [f.name, f.type, f.nullable]), [
      ['id', 'integer', false], ['customer_id', 'integer', false], ['amount', 'number', false], ['placed_at', 'date-time', false], ['notes', 'json', true],
    ]);
    assert.deepEqual(orders.relationships.map((r) => [r.field, r.targetObject, r.targetField, r.confidence, r.evidence.declared]),
      [['customer_id', 'customers', 'id', 1, true]]);
    const customers = out.schema.objects.find((o) => o.name === 'customers')!;
    assert.deepEqual(customers.fields.map((f) => f.type), ['integer', 'string', 'date', 'boolean']);
  });
});
