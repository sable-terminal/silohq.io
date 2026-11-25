// The OData protocol engine end to end (spec 14.4: SAP S/4HANA and ECC through OData): a
// manifest, not code, connects an OData service. Filters, sort and limit compile to $filter,
// $orderby and $top with typed literals (a quote doubled, never syntax); records and paging
// follow the version (4.0's value and @odata.nextLink; 2.0's d.results, d.__next and /Date()/);
// a next link leaving the connection is refused; writes are POST, PATCH (2.0: MERGE), PUT and
// DELETE to typed keys, a create reading its key from the entity returned; a draft comes from
// the service's $metadata with no model.

import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { writeRecords } from '../../src/contracts/connect-runtime/write.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import type { PlanStepInput } from '../../src/contracts/connect/step.contract.ts';
import { explainPushdown } from '../../src/contracts/pushdown-compiler/pushdown.contract.ts';
import { importDraft } from '../../src/contracts/visual-builder/builder.contract.ts';
import { draftConnector, getBuild, probeBuild, type BuildView } from '../../src/contracts/connector-builder/build.contract.ts';
import { service as conformanceService } from '../../src/routes/conformance/index.route.ts';
import { service as builderService } from '../../src/routes/connector-builder/index.route.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import { service as visualService } from '../../src/routes/visual-builder/index.route.ts';
import { literal } from '../../src/services/connect-runtime/protocols/odata/odata.protocol.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let api: Server;
let baseUrl: string;
const received: { method: string; path: string; query: URLSearchParams; headers: IncomingHttpHeaders; body: string }[] = [];

const PARTNERS = Array.from({ length: 7 }, (_, i) => ({
  BusinessPartner: `100${i + 1}`, Name: i === 0 ? "O'Brien & Co" : `Partner ${i + 1}`, Country: i % 2 === 0 ? 'GB' : 'DE', Rating: i + 1,
  CreatedOn: `2026-0${(i % 9) + 1}-15T10:00:00Z`,
}));
const PAGE = 3;

/** The few $filter forms the engine writes, evaluated over a record (enough for the fake). */
function matches(record: Record<string, unknown>, filter: string | null): boolean {
  if (filter === null) return true;
  return filter.split(' and ').every((term) => {
    let m = /^\((.*)\)$/.exec(term);
    if (m) return m[1]!.split(' or ').some((t) => matches(record, t));
    m = /^(\w+) (eq|ne|gt|ge|lt|le) (.+)$/.exec(term);
    if (m) {
      const value = m[3]!.startsWith("'") ? m[3]!.slice(1, -1).replaceAll("''", "'") : m[3] === 'null' ? null : Number(m[3]);
      const have = record[m[1]!] as string | number | null;
      switch (m[2]) {
        case 'eq': return have === value;
        case 'ne': return have !== value;
        case 'gt': return (have as number) > (value as number);
        case 'ge': return (have as number) >= (value as number);
        case 'lt': return (have as number) < (value as number);
        default: return (have as number) <= (value as number);
      }
    }
    m = /^startswith\((\w+),'(.*)'\)$/.exec(term);
    if (m) return String(record[m[1]!] ?? '').startsWith(m[2]!.replaceAll("''", "'"));
    m = /^contains\((\w+),'(.*)'\)$/.exec(term) ?? /^substringof\('(.*)',(\w+)\)$/.exec(term);
    if (m) {
      const [field, text] = term.startsWith('contains') ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
      return String(record[field] ?? '').includes(text.replaceAll("''", "'"));
    }
    throw new Error(`the fake does not read ${term}`);
  });
}

before(async () => {
  api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method: req.method!, path: url.pathname, query: url.searchParams, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      const v2 = url.pathname.startsWith('/sap/v2/');
      // /open/ stands for a service a draft reaches before its auth is set: the same data, no token.
      if (!url.pathname.startsWith('/open/') && req.headers.authorization !== 'Bearer odata_token') { res.statusCode = 401; res.end('{"error":{"code":"401"}}'); return; }
      if (!/\/Partners(\('(?:[^']|'')+'\))?$/.test(url.pathname)) { res.statusCode = 404; res.end('{"error":{"code":"404"}}'); return; }
      const key = /\/Partners\('((?:[^']|'')+)'\)$/.exec(url.pathname);
      if (req.method === 'POST' && /\/Partners$/.test(url.pathname)) {
        const created = { ...JSON.parse(body), BusinessPartner: `100${PARTNERS.length + 1}` };
        PARTNERS.push(created);
        res.statusCode = 201;
        res.end(JSON.stringify(v2 ? { d: created } : created));
        return;
      }
      if (key && (req.method === 'PATCH' || (req.method === 'POST' && req.headers['x-http-method'] === 'MERGE') || req.method === 'PUT')) {
        const found = PARTNERS.find((p) => p.BusinessPartner === key[1]!.replaceAll("''", "'"));
        if (!found) { res.statusCode = 404; res.end('{"error":{"code":"404"}}'); return; }
        Object.assign(found, JSON.parse(body));
        res.statusCode = 204;
        res.end();
        return;
      }
      if (key && req.method === 'DELETE') {
        PARTNERS.splice(PARTNERS.findIndex((p) => p.BusinessPartner === key[1]), 1);
        res.statusCode = 204;
        res.end();
        return;
      }
      if (url.searchParams.get('$filter') === "Name eq 'away'") {
        res.end(JSON.stringify({ value: [PARTNERS[0]], '@odata.nextLink': 'https://elsewhere.example/odata/Partners?$skiptoken=x' }));
        return;
      }
      const filtered = PARTNERS.filter((p) => matches(p, url.searchParams.get('$filter')));
      const orderby = url.searchParams.get('$orderby');
      if (orderby) {
        const [field, dir] = orderby.split(' ');
        filtered.sort((a, b) => (String(a[field as keyof typeof a]) < String(b[field as keyof typeof b]) ? -1 : 1) * (dir === 'desc' ? -1 : 1));
      }
      const top = url.searchParams.get('$top') === null ? filtered.length : Number(url.searchParams.get('$top'));
      const skip = Number(url.searchParams.get('$skiptoken') ?? 0);
      const pageRows = filtered.slice(0, top).slice(skip, skip + PAGE);
      const more = skip + PAGE < Math.min(top, filtered.length);
      const nextQuery = new URLSearchParams(url.searchParams);
      nextQuery.set('$skiptoken', String(skip + PAGE));
      if (v2) {
        const rows = pageRows.map((p) => ({ ...p, CreatedOn: `/Date(${Date.parse(p.CreatedOn)})/`, Rating: String(p.Rating) }));
        res.end(JSON.stringify({ d: { results: rows, ...(more ? { __next: `${baseUrl}${url.pathname}?${nextQuery}` } : {}) } }));
      } else {
        res.end(JSON.stringify({ value: pageRows, ...(more ? { '@odata.nextLink': `Partners?${nextQuery}` } : {}) }));
      }
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  cell = await createConnectCell();
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
  await cell.start(visualService, 'visual-builder', 'test_app');
  await cell.start(conformanceService, 'conformance', 'test_app');
  await cell.start(builderService, 'connector-builder', 'test_app');
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
});

after(async () => {
  await cell?.close();
  api?.close();
});

const BEARER = { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] };
const TYPES = { BusinessPartner: 'Edm.String', Name: 'Edm.String', Country: 'Edm.String', Rating: 'Edm.Int32', CreatedOn: 'Edm.DateTimeOffset' };

function manifest(version: '4.0' | '2.0', extra: { writes?: unknown } = {}) {
  return doc({
    schemaVersion: '1',
    identity: { name: 'Example S/4HANA', provider: 'SAP', version: '1.0.0' },
    transport: { viaAgent: false, baseUrl: `${baseUrl}/sap/${version === '4.0' ? 'v4' : 'v2'}/API_BUSINESS_PARTNER` },
    protocol: { kind: 'odata', version },
    auth: BEARER,
    objects: [{
      name: 'partners', identifier: ['id'],
      fields: [
        { name: 'id', type: 'string', path: 'BusinessPartner' }, { name: 'name', type: 'string', path: 'Name' }, { name: 'country', type: 'string', path: 'Country' },
        { name: 'rating', type: 'integer', path: 'Rating' }, { name: 'created_on', type: 'date-time', path: 'CreatedOn' },
      ],
      source: { kind: 'odata', servicePath: '/', entitySet: 'Partners', types: version === '2.0' ? { ...TYPES, CreatedOn: 'Edm.DateTime' } : TYPES, maxPages: 10 },
      pushdown: {
        filters: [
          { field: 'country', ops: ['eq', 'in'] }, { field: 'rating', ops: ['gt', 'lte'] }, { field: 'name', ops: ['eq', 'contains'] },
        ],
        sort: [{ field: 'rating' }], limit: {},
      },
      ...(extra.writes === undefined ? {} : { writes: extra.writes }),
    }],
  });
}

async function connection(version: '4.0' | '2.0', document?: Record<string, never>): Promise<string> {
  const connector = await gateway.call(createConnector, { body: { slug: `odata-${uuidv7().slice(-12)}`, name: 'S/4HANA', provider: 'SAP', sourceRoute: 'visual' } },
    { ...cell.as(root), idempotencyKey: uuidv7() });
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: document ?? manifest(version) } }, { ...cell.as(root), idempotencyKey: uuidv7() });
  const created = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'S/4HANA', owningScopeId: cell.scopes['engineering']! } },
    { ...cell.as(root), idempotencyKey: uuidv7() });
  await gateway.call(setConnectionSecrets, { params: { connectionId: created.id }, body: { values: { token: 'odata_token' } } }, cell.as(root));
  await gateway.call(changeConnectionStatus, { params: { connectionId: created.id }, body: { move: 'probe', version: created.version } }, cell.as(root));
  return created.id;
}

const read = (connectionId: string, step: PlanStepInput) =>
  cell.client('executor').call(readObject, { body: { connectionId, reason: 'probe', step: step as never } }, cell.as(root));

describe('OData literals', () => {
  test('a value is a typed literal: a quote doubled, a number checked, the version\'s forms', () => {
    assert.equal(literal('4.0', 'Edm.String', "O'Brien) or 1 eq 1 or ('"), "'O''Brien) or 1 eq 1 or ('''");
    assert.equal(literal('4.0', 'Edm.Int32', 5), '5');
    assert.throws(() => literal('4.0', 'Edm.Int32', '5 or true'), { code: 'odata.literal_invalid' });
    assert.equal(literal('2.0', 'Edm.Decimal', '1.5'), '1.5M');
    assert.equal(literal('2.0', 'Edm.Guid', '0b1e2f3a-0000-4000-8000-000000000001'), "guid'0b1e2f3a-0000-4000-8000-000000000001'");
    assert.equal(literal('4.0', 'Edm.DateTimeOffset', '2026-01-02T03:04:05Z'), '2026-01-02T03:04:05.000Z');
    assert.equal(literal('2.0', 'Edm.DateTime', '2026-01-02T03:04:05Z'), "datetime'2026-01-02T03:04:05.000'");
  });
});

describe('the OData engine (spec 14.4)', () => {
  let v4: string;
  let v2: string;

  before(async () => {
    v4 = await connection('4.0');
    v2 = await connection('2.0');
  });

  test('4.0: pages by @odata.nextLink within the connection; $select of the fields read; the version\'s headers', async () => {
    const start = received.length;
    const out = await read(v4, { object: 'partners' });
    assert.equal(out.rows.length, 7);
    assert.equal(out.stats.pages, 3, 'three, three, one');
    assert.deepEqual(out.rows[0], { id: '1001', name: "O'Brien & Co", country: 'GB', rating: 1, created_on: '2026-01-15T10:00:00Z' });
    const first = received[start]!;
    assert.equal(first.path, '/sap/v4/API_BUSINESS_PARTNER/Partners');
    assert.equal(first.query.get('$select'), 'BusinessPartner,Name,Country,Rating,CreatedOn');
    assert.equal(first.headers['odata-version'], '4.0');
    assert.deepEqual(received.slice(start).map((r) => r.query.get('$skiptoken')), [null, '3', '6']);
  });

  test('filters, sort and limit compile to $filter, $orderby and $top; a value never becomes syntax', async () => {
    let start = received.length;
    const out = await read(v4, {
      object: 'partners', fields: ['id'], filters: [{ field: 'country', op: 'in', value: ['GB', 'FR'] }, { field: 'rating', op: 'gt', value: 2 }],
      sort: [{ field: 'rating', direction: 'desc' }], limit: 2,
    });
    assert.deepEqual(out.pushdown.residual, { filters: [], sort: [], limit: null, aggregate: null });
    assert.deepEqual(out.rows.map((r) => r['id']), ['1007', '1005']);
    assert.equal(received[start]!.query.get('$filter'), "(Country eq 'GB' or Country eq 'FR') and Rating gt 2");
    assert.deepEqual([received[start]!.query.get('$orderby'), received[start]!.query.get('$top')], ['Rating desc', '2']);

    start = received.length;
    const hostile = await read(v4, { object: 'partners', fields: ['id'], filters: [{ field: 'name', op: 'eq', value: "O'Brien & Co' or Country eq 'DE" }] });
    assert.deepEqual(hostile.rows, [], 'the whole text is one string literal');
    assert.equal(received[start]!.query.get('$filter'), "Name eq 'O''Brien & Co'' or Country eq ''DE'");
    const contains = await read(v4, { object: 'partners', fields: ['id'], filters: [{ field: 'name', op: 'contains', value: "O'Brien" }] });
    assert.deepEqual(contains.rows.map((r) => r['id']), ['1001']);

    const explained = await cell.client('planner').call(explainPushdown, {
      body: { connectionId: v4, step: { object: 'partners', filters: [{ field: 'rating', op: 'lte', value: 3 }], limit: 5 } as never },
    }, cell.as(root));
    assert.deepEqual(explained.native, { protocol: 'odata', entitySet: 'Partners', query: { $filter: 'Rating le 3', $top: '5' } });
  });

  test('2.0: d.results and d.__next, $format=json, /Date()/ read as an instant, a number sent as text read as a number', async () => {
    const start = received.length;
    const out = await read(v2, { object: 'partners', filters: [{ field: 'name', op: 'contains', value: 'Partner' }] });
    assert.equal(out.rows.length, 6);
    assert.equal(out.stats.pages, 2);
    assert.deepEqual(out.rows[0], { id: '1002', name: 'Partner 2', country: 'DE', rating: 2, created_on: '2026-02-15T10:00:00.000Z' });
    assert.equal(received[start]!.query.get('$format'), 'json');
    assert.equal(received[start]!.query.get('$filter'), "substringof('Partner',Name)");
    assert.equal(received[start]!.headers['dataserviceversion'], '2.0');
  });

  test('a next link that leaves the connection is refused, never followed', async () => {
    const before = received.length;
    await assert.rejects(read(v4, { object: 'partners', filters: [{ field: 'name', op: 'eq', value: 'away' }] }), { code: 'odata.next_link_foreign' });
    assert.equal(received.length - before, 1, 'one request: the link to elsewhere was not followed');
  });

  test('writes: POST, PATCH (2.0: MERGE) and DELETE to typed keys; a create reads its key from the entity returned', async () => {
    const writes = { create: {}, update: {}, delete: {}, bounds: { maxRows: 10 } };
    for (const version of ['4.0', '2.0'] as const) {
      const id = await connection(version, manifest(version, { writes }));
      const write = (operations: unknown[]) => cell.client('conformance').call(writeRecords, {
        body: { connectionId: id, object: 'partners', sandbox: true, operations: operations as never },
      }, cell.as(root));
      const created = await write([{ key: 'c', operation: 'create', values: { name: 'Ada', country: 'GB', rating: 9 } }]);
      assert.equal(created.results[0]!.outcome, 'applied');
      const newId = created.results[0]!.identifier!;
      assert.equal(newId, PARTNERS.at(-1)!.BusinessPartner);
      const posted = received.at(-1)!;
      assert.deepEqual([posted.method, JSON.parse(posted.body)], ['POST', { Name: 'Ada', Country: 'GB', Rating: 9 }], 'under the service\'s property names');
      const updated = await write([{ key: 'u', operation: 'update_partial', identifier: newId, values: { rating: 10 } }]);
      assert.equal(updated.results[0]!.outcome, 'applied');
      const patched = received.at(-1)!;
      assert.equal(patched.path.endsWith(`/Partners('${newId}')`), true);
      assert.equal(version === '4.0' ? patched.method : patched.headers['x-http-method'], version === '4.0' ? 'PATCH' : 'MERGE');
      assert.equal(PARTNERS.find((p) => p.BusinessPartner === newId)!.Rating, 10);
      const deleted = await write([{ key: 'd', operation: 'delete', identifier: newId, values: {} }]);
      assert.equal(deleted.results[0]!.outcome, 'applied');
      assert.equal(PARTNERS.some((p) => p.BusinessPartner === newId), false);
    }
  });
});

describe('a draft from $metadata (14.4: OData\'s discovery model)', () => {
  const V4 = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="API_BUSINESS_PARTNER" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Partner">
        <Key><PropertyRef Name="BusinessPartner"/></Key>
        <Property Name="BusinessPartner" Type="Edm.String" Nullable="false"/>
        <Property Name="Name" Type="Edm.String"/>
        <Property Name="Rating" Type="Edm.Int32"/>
        <Property Name="CreatedOn" Type="Edm.DateTimeOffset"/>
        <Property Name="Address" Type="API_BUSINESS_PARTNER.Address"/>
      </EntityType>
      <EntityType Name="Order">
        <Key><PropertyRef Name="OrderID"/></Key>
        <Property Name="OrderID" Type="Edm.Int64" Nullable="false"/>
        <Property Name="PartnerID" Type="Edm.String"/>
        <Property Name="Amount" Type="Edm.Decimal"/>
        <NavigationProperty Name="Partner" Type="API_BUSINESS_PARTNER.Partner">
          <ReferentialConstraint Property="PartnerID" ReferencedProperty="BusinessPartner"/>
        </NavigationProperty>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Partners" EntityType="API_BUSINESS_PARTNER.Partner"/>
        <EntitySet Name="Orders" EntityType="API_BUSINESS_PARTNER.Order"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  test('entity sets become objects: keys, typed fields, filters by type, sort and limit, and relationships, with no model', async () => {
    const out = await gateway.call(importDraft, {
      body: { kind: 'odata', text: V4, name: 'S/4HANA', provider: 'SAP', baseUrl: `${baseUrl}/sap/v4/API_BUSINESS_PARTNER/$metadata` },
    }, cell.as(root));
    const document = out.document as { protocol: unknown; transport: { baseUrl: string }; objects: { name: string; identifier: string[]; fields: { name: string; type: string; path?: string }[];
      source: { entitySet: string; types: Record<string, string> }; pushdown: { filters: { field: string; ops: string[] }[] }; relationships?: unknown[] }[] };
    assert.deepEqual(document.protocol, { kind: 'odata', version: '4.0' });
    assert.equal(document.transport.baseUrl, `${baseUrl}/sap/v4/API_BUSINESS_PARTNER`);
    const partners = document.objects.find((o) => o.source.entitySet === 'Partners')!;
    assert.deepEqual(partners.identifier, ['business_partner']);
    assert.deepEqual(partners.fields.map((f) => [f.name, f.type]), [['business_partner', 'string'], ['name', 'string'], ['rating', 'integer'], ['created_on', 'date-time']]);
    assert.equal(partners.source.types['Rating'], 'Edm.Int32');
    assert.ok(partners.pushdown.filters.find((f) => f.field === 'rating')!.ops.includes('gt'));
    assert.ok(partners.pushdown.filters.find((f) => f.field === 'name')!.ops.includes('contains'));
    assert.ok(!partners.pushdown.filters.find((f) => f.field === 'rating')!.ops.includes('contains'));
    const orders = document.objects.find((o) => o.source.entitySet === 'Orders')!;
    assert.deepEqual(orders.relationships, [{ field: 'partner_id', targetObject: partners.name, targetField: 'business_partner', kind: 'foreign_key' }]);
    assert.ok(out.notes.includes('Partners_complex_properties_left_out'));
    assert.ok(out.notes.includes('writes_not_described'));
    await assert.rejects(gateway.call(importDraft, { body: { kind: 'odata', text: `<!DOCTYPE x>${V4}`, name: 'x', provider: 'x', baseUrl } }, cell.as(root)),
      { code: 'visual.import_dtd' });
  });
});

describe('the AI builder from a typed description (spec 16.3, 14.4)', () => {
  const METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>
  <Schema Namespace="API" xmlns="http://docs.oasis-open.org/odata/ns/edm">
    <EntityType Name="Partner"><Key><PropertyRef Name="BusinessPartner"/></Key>
      <Property Name="BusinessPartner" Type="Edm.String" Nullable="false"/><Property Name="Name" Type="Edm.String"/>
      <Property Name="Country" Type="Edm.String"/><Property Name="Rating" Type="Edm.Int32"/></EntityType>
    <EntityType Name="Missing"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.String" Nullable="false"/></EntityType>
    <EntityContainer Name="C"><EntitySet Name="Partners" EntityType="API.Partner"/><EntitySet Name="Gone" EntityType="API.Missing"/></EntityContainer>
  </Schema></edmx:DataServices></edmx:Edmx>`;

  async function settled(connectionId: string): Promise<BuildView> {
    for (let i = 0; i < 1_200; i++) {
      const view = await gateway.call(getBuild, { params: { connectionId } }, cell.as(root));
      if (!view.running && view.stage !== 'parse') return view;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the build did not settle');
  }

  test('$metadata is compiled with no model; each entity set is read as declared; one that does not read is left out and named', async () => {
    const draft = await gateway.call(draftConnector, {
      body: {
        name: 'S4', slug: `s4-${uuidv7().slice(-8)}`, provider: 'SAP', baseUrl: `${baseUrl}/open/v4/API`,
        documentation: { kind: 'odata', text: METADATA }, sandbox: { name: 'S4 sandbox', owningScopeId: cell.scopes['engineering']! },
      },
    }, { ...cell.as(root), idempotencyKey: uuidv7() });
    const parse = draft.stages.find((s) => s.stage === 'parse')!.findings as { source: string; model: boolean; charged: boolean; described: boolean; objects: number };
    assert.deepEqual([parse.source, parse.model, parse.charged, parse.described, parse.objects], ['odata', false, false, true, 2]);
    await gateway.call(probeBuild, { params: { connectionId: draft.connectionId } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    const build = await settled(draft.connectionId);
    const probe = build.stages.find((s) => s.stage === 'probe')!.findings as { objects: { object: string; sampled: number }[]; dropped: { object: string }[] };
    assert.deepEqual(probe.objects.map((o) => o.object), ['partners']);
    assert.ok(probe.objects[0]!.sampled >= 7);
    assert.deepEqual(probe.dropped.map((d) => d.object), ['gone'], 'an entity set that does not read is named');
    assert.equal(build.stages.find((s) => s.stage === 'reconcile')!.status, 'completed');
    const conform = build.stages.find((s) => s.stage === 'conform')!;
    assert.equal(conform.status, 'completed', JSON.stringify(conform.errors ?? conform.findings));
    assert.deepEqual(build.proposals.map((p) => [p.object, p.identifier]), [['partners', ['business_partner']]]);
  });
});
