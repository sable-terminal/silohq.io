// connector-builder (spec 16.3): the AI route, graded against hand-built connectors as spec 16.2
// orders ("catalogue connectors ... become the grading corpus against which the AI builder is
// measured").
//
// Two fake APIs, each with a hand-built reference manifest (tests/fixtures/connectors):
// - Ledger, built from its OpenAPI document, which is wrong in places (a field it never
//   returns, two it returns undocumented, a number documented as text): no model call.
// - Tasks, built from pasted documentation through the model gateway and a fake model
//   whose first draft puts the records in the wrong place and one object at the wrong
//   path: the probe corrects the first, and one more model round the second.
// Grading reads every page of every reference object through both connections and asks
// that the built connector return the same records, by identifier, with every reference
// field equal.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { recognise } from '../../src/services/connector-builder/documentation.service.ts';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { createConnection, getConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion, getManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { confirmBuild, draftConnector, getBuild, previewBuild, probeBuild, type BuildView } from '../../src/contracts/connector-builder/build.contract.ts';
import { manifestSchema, type Manifest } from '../../src/contracts/connect/manifest.contract.ts';
import { charge } from '../../src/contracts/metering/charge.contract.ts';
import { route } from '../../src/infra/http.infra.ts';
import { defineService } from '../../src/infra/service.infra.ts';
import { service as conformanceService } from '../../src/routes/conformance/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as builderService } from '../../src/routes/connector-builder/index.route.ts';
import { service as modelGatewayService } from '../../src/routes/model-gateway/index.route.ts';
import { service as inferenceService } from '../../src/routes/schema-inference/index.route.ts';
import { compileDraft, type Draft } from '../../src/services/connector-builder/draft.service.ts';
import { draftFromOpenApi, parseOpenApi } from '../../src/services/connector-builder/openapi.service.ts';
import { fullIssues } from '../../src/services/visual-builder/draft.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'connectors');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

// ----------------------------------------------------------------------------- the fake APIs

const CUSTOMERS = Array.from({ length: 12 }, (_, i) => ({
  id: `cus_${i + 1}`, name: `Customer ${i + 1}`, email: `c${i + 1}@ledger.example`, country: i % 3 === 0 ? 'FR' : 'GB',
  created: `2026-0${(i % 9) + 1}-0${(i % 7) + 1}T09:00:00Z`,
}));
const INVOICES = Array.from({ length: 9 }, (_, i) => ({
  id: 1000 + i, customer_id: `cus_${(i % 12) + 1}`, total: (i + 1) * 10.5, status: i % 2 === 0 ? 'paid' : 'open', issued: `2026-05-0${i + 1}`,
}));
const PROJECTS = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Apollo ${i + 1}`, archived: i === 6 }));
const TASKS = Array.from({ length: 8 }, (_, i) => ({ id: 50 + i, project_id: (i % 7) + 1, title: `Task ${i + 1}`, done: i % 3 === 0, due: `2026-06-1${i}` }));

function serve(handler: (req: IncomingMessage, url: URL) => [number, unknown]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const [status, body] = handler(req, new URL(req.url!, 'http://x'));
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

const cursorPage = <T>(rows: readonly T[], url: URL, size: number): [number, unknown] => {
  const from = Number(url.searchParams.get('cursor') ?? 0);
  const next = from + size < rows.length ? String(from + size) : null;
  return [200, { data: rows.slice(from, from + size), meta: { next_cursor: next } }];
};

const numberedPage = <T>(rows: readonly T[], url: URL): [number, unknown] => {
  const size = Number(url.searchParams.get('per_page') ?? 3);
  const page = Number(url.searchParams.get('page') ?? 1);
  return [200, { items: rows.slice((page - 1) * size, page * size), page, total_pages: Math.ceil(rows.length / size) }];
};

// ----------------------------------------------------------------------------- the fake model

const DRAFT_ONE = {
  baseUrl: null, auth: { strategy: 'api_key', location: 'header', key: 'X-Api-Key', prefix: null },
  objects: [
    {
      name: 'projects', label: 'Projects', path: '/api/projects', recordsPath: 'data', identifier: 'id',
      fields: [{ name: 'id', path: 'id', type: 'integer' }, { name: 'name', path: 'name', type: 'string' }, { name: 'archived', path: 'archived', type: 'boolean' }],
      paging: { style: 'page', param: 'page', path: 'total_pages', sizeParam: 'per_page', size: 3 }, filters: [],
    },
    {
      name: 'tasks', label: 'Tasks', path: '/api/task-list', recordsPath: 'items', identifier: 'id',
      fields: [
        { name: 'id', path: 'id', type: 'integer' }, { name: 'projectId', path: 'project_id', type: 'integer' }, { name: 'title', path: 'title', type: 'string' },
        { name: 'done', path: 'done', type: 'boolean' }, { name: 'due', path: 'due', type: 'date' },
      ],
      paging: { style: 'page', param: 'page', path: 'total_pages', sizeParam: 'per_page', size: 3 }, filters: [],
    },
  ],
};
const DRAFT_TWO = { ...DRAFT_ONE, objects: [{ ...DRAFT_ONE.objects[1]!, path: '/api/tasks' }] };

let ledger: { server: Server; url: string };
let tasks: { server: Server; url: string };
let model: { server: Server; url: string };
const modelRequests: string[] = [];
const charges: unknown[] = [];
let cell: ConnectCell;
let root: Signed;

before(async () => {
  ledger = await serve((req, url) => {
    // Its own description, public, where a service usually publishes it (16.3 input 3).
    if (url.pathname === '/openapi.json') return [200, JSON.parse(fixture('ledger.openapi.json'))];
    if (url.pathname === '/docs/spec') return [200, JSON.parse(fixture('ledger.openapi.json'))];
    if (url.pathname === '/docs/missing') return [404, { error: 'not found' }];
    if (req.headers.authorization !== 'Bearer tok_ledger') return [401, { error: 'unauthorised' }];
    if (url.pathname === '/v2/customers') return cursorPage(CUSTOMERS, url, 5);
    if (url.pathname === '/v2/invoices') {
      const status = url.searchParams.get('status');
      return cursorPage(status === null ? INVOICES : INVOICES.filter((i) => i.status === status), url, 4);
    }
    return [404, { error: 'not found' }];
  });
  tasks = await serve((req, url) => {
    if (req.headers['x-api-key'] !== 'key_tasks') return [401, { error: 'unauthorised' }];
    if (url.pathname === '/api/projects') return numberedPage(PROJECTS, url);
    if (url.pathname === '/api/tasks') return numberedPage(TASKS, url);
    return [404, { error: 'not found' }];
  });
  const modelServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      modelRequests.push(body);
      const draft = body.includes('not found for these objects') ? DRAFT_TWO : DRAFT_ONE;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'open-weights-test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(draft) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 400, completion_tokens: 300 },
      }));
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  model = { server: modelServer, url: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}` };
  const routes = path.join(mkdtempSync(path.join(tmpdir(), 'silo-builder-')), 'routes.json');
  writeFileSync(routes, JSON.stringify([{
    role: 'connector_generation', provider: 'self_hosted', endpoint: model.url, model: 'open-weights-test', region: 'uk-lon-1',
    zeroRetention: true, maxOutputTokens: 8192,
  }]));

  // Metering stands in as a fake under its own name: what matters here is that generation is
  // charged once, keyed, and naming the manifest it bought.
  const fakeMetering = defineService({
    name: 'metering',
    needs: { redis: ['data'] },
    create: () => ({
      routes: [route(charge, {
        async handle({ body }) {
          charges.push(body);
          return { charged: true as const, transactionId: String(charges.length), operation: body.operation, pool: 'tokens' as const, weight: '6', source: 'allowance' as const };
        },
        resultRef: () => uuidv7(),
        async replay() {
          return { charged: true as const, transactionId: '1', operation: 'connector_generation' as const, pool: 'tokens' as const, weight: '6', source: 'allowance' as const };
        },
      })],
    }),
  });

  cell = await createConnectCell();
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(conformanceService, 'conformance', 'test_app');
  await cell.start(inferenceService, 'schema-inference', 'test_app');
  await cell.start(modelGatewayService, 'model-gateway', 'test_model_gateway' as 'test_app', { MODEL_ROUTES_FILE: routes });
  await cell.start(fakeMetering, 'metering', 'test_app', { DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: 'nats://127.0.0.1:1' });
  await cell.start(builderService, 'connector-builder', 'test_app');
  root = await cell.signIn('root@acme.example');
});

after(async () => {
  await cell?.close();
  for (const s of [ledger, tasks, model]) s?.server.close();
});

// ----------------------------------------------------------------------------- helpers

const gateway = () => cell.client('gateway');

async function settled(connectionId: string, who: Signed): Promise<BuildView> {
  for (let i = 0; i < 1_200; i++) {
    const view = await gateway().call(getBuild, { params: { connectionId } }, cell.as(who));
    if (!view.running && view.stage !== 'parse') return view;
    await sleep(100);
  }
  throw new Error('the build did not settle');
}

/** A reference connector from its fixture, as a hand-built one would be, with its secret. */
async function reference(file: string, baseUrl: string, secrets: Record<string, string>): Promise<{ connectionId: string; manifest: Manifest }> {
  const document = JSON.parse(fixture(file).replaceAll('{baseUrl}', baseUrl)) as Record<string, unknown>;
  const key = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
  const connector = await gateway().call(createConnector, { body: { slug: `ref-${uuidv7().slice(-12)}`, name: 'Reference', provider: 'Example', sourceRoute: 'visual' } }, key());
  await gateway().call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: doc(document) } }, key());
  const connection = await gateway().call(createConnection, { body: { connectorId: connector.id, name: 'Reference', owningScopeId: cell.scopes['engineering']! } }, key());
  await gateway().call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: secrets } }, cell.as(root));
  return { connectionId: connection.id, manifest: manifestSchema.parse(document) };
}

async function currentManifest(connectionId: string, who: Signed): Promise<Manifest> {
  const connection = await gateway().call(getConnection, { params: { connectionId } }, cell.as(who));
  const version = await gateway().call(getManifestVersion, { params: { connectorId: connection.connectorId, versionId: connection.manifestId } }, cell.as(who));
  return manifestSchema.parse(version.document);
}

/** Every reference object's records through both connections: the same records, every reference field equal. */
async function grade(ref: { connectionId: string; manifest: Manifest }, builtConnectionId: string, who: Signed)
  : Promise<{ objects: number; matched: number; fields: number; equalFields: number; mismatches: string[] }> {
  const built = await currentManifest(builtConnectionId, who);
  const read = async (connectionId: string, object: string, as: Signed) => (await cell.client('executor').call(readObject, {
    body: { connectionId, reason: 'probe', step: { object } },
  }, cell.as(as))).rows;
  let matched = 0;
  let fields = 0;
  let equalFields = 0;
  const mismatches: string[] = [];
  for (const object of ref.manifest.objects) {
    if (object.source.kind !== 'rest') continue;
    const sourcePath = object.source.request.path;
    const twin = built.objects.find((o) => o.source.kind === 'rest' && o.source.request.path === sourcePath);
    if (twin === undefined) {
      mismatches.push(`${object.name}: not built`);
      continue;
    }
    const want = await read(ref.connectionId, object.name, root);
    const got = await read(builtConnectionId, twin.name, who);
    const id = object.identifier[0]!;
    const twinId = twin.fields.find((f) => (f.path ?? f.name) === (object.fields.find((x) => x.name === id)!.path ?? id))!.name;
    const byId = new Map(got.map((r) => [String(r[twinId]), r]));
    if (got.length !== want.length || want.some((r) => !byId.has(String(r[id])))) {
      mismatches.push(`${object.name}: ${got.length} records, wanted ${want.length}`);
      continue;
    }
    matched += 1;
    for (const field of object.fields) {
      fields += 1;
      const twinField = twin.fields.find((f) => (f.path ?? f.name) === (field.path ?? field.name));
      const equal = twinField !== undefined && want.every((r) => JSON.stringify(byId.get(String(r[id]))![twinField.name]) === JSON.stringify(r[field.name]));
      if (equal) equalFields += 1;
      else mismatches.push(`${object.name}.${field.name}`);
    }
  }
  return { objects: ref.manifest.objects.length, matched, fields, equalFields, mismatches };
}

const noValuesIn = async (connectionId: string, values: readonly string[]) => {
  const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    'select coalesce(findings::text, \'\') || coalesce(errors::text, \'\') as kept from connect.probe_runs where connection_id = $1', [connectionId]));
  const kept = rows.map((r) => r.kept as string).join('\n');
  for (const value of values) assert.equal(kept.includes(value), false, `the build keeps no record value (${value})`);
};

// ----------------------------------------------------------------------------- tests

describe('parse, in memory', () => {
  const openapi = (paths: object, extra: object = {}) => JSON.stringify({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths, ...extra });
  const list = (props: object, envelope?: object) => ({
    get: {
      parameters: [], responses: { 200: { description: 'ok', content: { 'application/json': { schema: envelope ?? { type: 'array', items: { type: 'object', properties: props } } } } } },
    },
  });

  test('paging from query parameters and the envelope: page with its count, offset with its size', () => {
    const { draft } = draftFromOpenApi(parseOpenApi(openapi({
      '/a': { get: { ...list({}).get, parameters: [{ name: 'page', in: 'query' }, { name: 'per_page', in: 'query' }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: {
          results: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } }, total_pages: { type: 'integer' } } } } } } } } },
      '/b': { get: { ...list({}).get, parameters: [{ name: 'offset', in: 'query' }, { name: 'limit', in: 'query' }],
        responses: list({ code: { type: 'string' }, when: { type: 'string', format: 'date' } }).get.responses } },
    })));
    assert.deepEqual(draft.objects.map((o) => [o.name, o.recordsPath, o.paging.style, o.paging.path, o.identifier]),
      [['a', 'results', 'page', 'total_pages', 'id'], ['b', null, 'offset', null, null]]);
    assert.equal(draft.objects[1]!.fields.find((f) => f.name === 'when')!.type, 'date');
  });

  test('an unsupported scheme is noted, a document with no list is refused, aliases are refused', () => {
    const { draft, notes } = draftFromOpenApi(parseOpenApi(openapi({ '/a': list({ id: { type: 'string' } }) }, {
      components: { securitySchemes: { o: { type: 'oauth2' } } }, security: [{ o: [] }],
    })));
    assert.equal(draft.auth.strategy, 'none');
    assert.deepEqual(notes, ['auth_scheme_unsupported:oauth2']);
    assert.throws(() => draftFromOpenApi(parseOpenApi(openapi({ '/a/{id}': list({ id: { type: 'string' } }) }))), { code: 'build.openapi_no_objects' });
    assert.throws(() => parseOpenApi('openapi: 3.0.3\na: &x {b: 1}\nc: *x\n'), { code: 'build.openapi_unreadable' });
    assert.throws(() => parseOpenApi('{"not": "openapi"}'), { code: 'build.openapi_unreadable' });
  });

  test('the compile writes every expression; an unusable path or field is left out and noted', () => {
    const draft: Draft = {
      baseUrl: 'https://api.example/', auth: { strategy: 'basic', location: null, key: null, prefix: null },
      objects: [
        { name: 'Orders', label: null, path: '/v1/orders', recordsPath: 'data.items', identifier: 'orderId',
          fields: [{ name: 'orderId', path: 'orderId', type: 'string' }, { name: 'bad', path: 'a..b', type: 'string' }],
          paging: { style: 'cursor', param: 'after', path: 'paging.next', sizeParam: null, size: null }, filters: [{ field: 'orderId', param: 'id' }] },
        { name: 'escape', label: null, path: '/../etc', recordsPath: null, identifier: 'id', fields: [{ name: 'id', path: 'id', type: 'string' }],
          paging: { style: 'none', param: null, path: null, sizeParam: null, size: null }, filters: [] },
      ],
    };
    const { document, notes, names } = compileDraft(draft, { name: 'X', provider: 'Example', version: '0.1.0' }, undefined);
    assert.deepEqual(names, ['orders', null]);
    assert.deepEqual(notes.map((n) => n.note).sort(), ['field_path_unusable:bad', 'path_unusable']);
    assert.equal(document.transport.baseUrl, 'https://api.example');
    const { manifest, issues } = fullIssues(document);
    assert.deepEqual(issues, []);
    assert.deepEqual(manifest!.objects[0]!.identifier, ['order_id']);
    assert.equal(manifest!.objects[0]!.source.kind === 'rest' && manifest!.objects[0]!.source.records.jsonata, 'data.items');
    assert.deepEqual(manifest!.auth.fields.map((f) => [f.name, f.kind]), [['username', 'public'], ['password', 'secret']]);
  });
});

describe('from an OpenAPI document, without a model (Ledger)', () => {
  let build: BuildView;

  test('parse compiles the document into a draft connector and a sandbox; nothing is generated, nothing charged', async () => {
    const key = uuidv7();
    build = await gateway().call(draftConnector, {
      body: {
        name: 'Ledger', slug: 'ledger', provider: 'Example', baseUrl: ledger.url,
        documentation: { kind: 'openapi', text: fixture('ledger.openapi.json') },
        sandbox: { name: 'Ledger sandbox', owningScopeId: cell.scopes['engineering']! },
      },
    }, { ...cell.as(root), idempotencyKey: key });
    assert.equal(build.stage, 'parse');
    assert.equal(build.status, 'completed');
    assert.equal(build.manifest.version, '0.1.0-draft.1');
    assert.equal(build.connectionStatus, 'draft');
    const parse = build.stages[0]!.findings as { model: boolean; charged: boolean; objects: number };
    assert.deepEqual([parse.model, parse.charged, parse.objects], [false, false, 2], 'the path with a parameter is not a list');
    assert.equal(charges.length, 0);
    const again = await gateway().call(draftConnector, {
      body: {
        name: 'Ledger', slug: 'ledger', provider: 'Example', baseUrl: ledger.url,
        documentation: { kind: 'openapi', text: fixture('ledger.openapi.json') },
        sandbox: { name: 'Ledger sandbox', owningScopeId: cell.scopes['engineering']! },
      },
    }, { ...cell.as(root), idempotencyKey: key });
    assert.equal(again.connectionId, build.connectionId, 'a retry drafts nothing new');
  });

  test('probe, reconcile, conform and propose run to the end; the probe is the source of truth', async () => {
    await gateway().call(setConnectionSecrets, { params: { connectionId: build.connectionId }, body: { values: { token: 'tok_ledger' } } }, cell.as(root));
    const started = await gateway().call(probeBuild, { params: { connectionId: build.connectionId } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    assert.equal(started.running, true);
    build = await settled(build.connectionId, root);
    assert.deepEqual(build.stages.map((s) => `${s.stage}:${s.status}`), [
      'parse:completed', 'probe:completed', 'reconcile:completed', 'conform:completed', 'propose_mapping:completed',
    ]);
    const reconcile = build.stages.find((s) => s.stage === 'reconcile')!.findings as { objects: { object: string; documentedOnly: string[]; typeChanged: string[]; observedOnly: number }[] };
    const customers = reconcile.objects.find((o) => o.object === 'customers')!;
    assert.deepEqual(customers.documentedOnly, ['phone'], 'documented, never returned: dropped');
    assert.equal(customers.observedOnly, 2, 'returned, undocumented: email and country kept');
    assert.deepEqual(reconcile.objects.find((o) => o.object === 'invoices')!.typeChanged, ['total']);
    assert.deepEqual(build.proposals.map((p) => [p.object, p.objectType]), [['customers', 'Customer'], ['invoices', 'Invoice']]);
    assert.deepEqual(build.proposals[1]!.links.map((l) => [l.field, l.targetObject, l.targetField]), [['customer_id', 'customers', 'id']]);
    assert.ok(build.conformanceRunId);
    await noValuesIn(build.connectionId, ['@ledger.example', 'Customer 1', '10.5']);
  });

  test('graded against the hand-built Ledger connector: the same records, every field equal', async () => {
    const result = await grade(await reference('ledger.reference.json', ledger.url, { token: 'tok_ledger' }), build.connectionId, root);
    assert.deepEqual(result.mismatches, []);
    assert.deepEqual([result.matched, result.equalFields], [result.objects, result.fields]);
    const built = await currentManifest(build.connectionId, root);
    assert.deepEqual(built.objects.find((o) => o.name === 'invoices')!.pushdown.filters.map((f) => f.field), ['status'], 'the documented filter survives conformance');
  });

  test('the person previews their records, confirms (with a correction) and the connection is verified', async () => {
    const preview = await gateway().call(previewBuild, { params: { connectionId: build.connectionId }, body: { object: 'customers', limit: 3 } }, cell.as(root));
    assert.equal(preview.rows.length, 3);
    assert.equal(preview.rows[0]!['email'], 'c1@ledger.example');
    const confirmed = await gateway().call(confirmBuild, {
      params: { connectionId: build.connectionId },
      body: { decisions: [{ object: 'customers', accept: true, objectType: 'Client' }, { object: 'invoices', accept: true }] },
    }, { ...cell.as(root), idempotencyKey: uuidv7() });
    assert.equal(confirmed.connectionStatus, 'verified');
    assert.deepEqual(confirmed.stages.slice(-2).map((s) => `${s.stage}:${s.status}`), ['confirm:completed', 'verify:completed']);
    const connection = await gateway().call(getConnection, { params: { connectionId: build.connectionId } }, cell.as(root));
    assert.deepEqual([connection.trustTier, connection.writesEnabled], ['private', false]);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload->'actor'->>'membershipId' as by, payload->'detail'->>'object_type' as type from platform.outbox
       where organisation_id = $1 and payload->>'event' = 'mapping_confirmed' and payload->'resource'->>'id' = $2
       order by payload->'detail'->>'object'`, [cell.org, build.connectionId]));
    assert.deepEqual(rows.map((r) => [r.by, r.type]), [[root.membershipId, 'Client'], [root.membershipId, 'Invoice']], 'mapping_confirmed names who decided');
  });
});

describe('from pasted documentation, through the model (Tasks)', () => {
  let member: Signed;
  let build: BuildView;

  test('documentation holding what looks like a record value is refused at parse, and nothing is sent', async () => {
    member = await cell.member('builder@acme.example', 'Member', 'platform');
    const before = modelRequests.length;
    await assert.rejects(gateway().call(draftConnector, {
      body: {
        name: 'Tasks', slug: 'tasks-bad', provider: 'Example', baseUrl: tasks.url,
        documentation: { kind: 'text', title: 'Tasks API', text: `${fixture('tasks.docs.md')}\nSupport: help@tasks.example` },
        sandbox: { name: 'Tasks sandbox', owningScopeId: cell.scopes['platform']! },
      },
    }, { ...cell.as(member), idempotencyKey: uuidv7() }), { code: 'build.documentation_values' });
    assert.equal(modelRequests.length, before);
  });

  test('the model drafts it, generation is charged once, and a retry neither calls the model nor charges again', async () => {
    const key = uuidv7();
    const body = {
      name: 'Tasks', slug: 'tasks', provider: 'Example', baseUrl: tasks.url,
      documentation: { kind: 'text' as const, title: 'Tasks API', text: fixture('tasks.docs.md') },
      sandbox: { name: 'Tasks sandbox', owningScopeId: cell.scopes['platform']! },
    };
    build = await gateway().call(draftConnector, { body }, { ...cell.as(member), idempotencyKey: key });
    const parse = build.stages[0]!.findings as { model: boolean; charged: boolean };
    assert.deepEqual([parse.model, parse.charged], [true, true]);
    assert.deepEqual(charges.map((c) => (c as { operation: string }).operation), ['connector_generation']);
    assert.equal((charges[0] as { connectorManifestId: string }).connectorManifestId, build.manifest.id, 'the charge names the manifest it bought');
    const requests = modelRequests.length;
    const again = await gateway().call(draftConnector, { body }, { ...cell.as(member), idempotencyKey: key });
    assert.equal(again.connectionId, build.connectionId);
    assert.equal(modelRequests.length, requests);
    assert.equal(charges.length, 1);
  });

  test('the probe fixes where the records sit; one more model round fixes the path the source did not know', async () => {
    await gateway().call(setConnectionSecrets, { params: { connectionId: build.connectionId }, body: { values: { api_key: 'key_tasks' } } }, cell.as(member));
    await gateway().call(probeBuild, { params: { connectionId: build.connectionId } }, { ...cell.as(member), idempotencyKey: uuidv7() });
    build = await settled(build.connectionId, member);
    assert.deepEqual(build.stages.map((s) => `${s.stage}:${s.status}`), [
      'parse:completed', 'probe:completed', 'probe:completed', 'reconcile:completed', 'conform:completed', 'propose_mapping:completed',
    ], 'two probes: the first draft, then the redrafted one');
    const reconcile = build.stages.find((s) => s.stage === 'reconcile')!.findings as { rounds: number; objects: { object: string; recordsPath: { documented: string; observed: string } }[] };
    assert.equal(reconcile.rounds, 1);
    assert.deepEqual(reconcile.objects.find((o) => o.object === 'projects')!.recordsPath, { documented: 'data', observed: 'items' });
    assert.equal(charges.length, 1, 'the second round is the same generation');
    const result = await grade(await reference('tasks.reference.json', tasks.url, { api_key: 'key_tasks' }), build.connectionId, member);
    assert.deepEqual(result.mismatches, []);
    assert.deepEqual([result.matched, result.equalFields], [result.objects, result.fields]);
    assert.deepEqual(build.proposals.find((p) => p.object === 'tasks')!.links.map((l) => [l.field, l.targetObject]), [['project_id', 'projects']]);
  });

  test('no record value ever reached the model or the build record', async () => {
    assert.ok(modelRequests.length >= 2);
    for (const value of ['Apollo', 'Task 1', '2026-06-1', 'key_tasks']) {
      assert.equal(modelRequests.some((r) => r.includes(value)), false, `the model never saw ${value}`);
    }
    await noValuesIn(build.connectionId, ['Apollo', 'Task 1']);
  });

  test('the member confirms, but verifying needs connector.verify: the build waits at verify', async () => {
    const out = await gateway().call(confirmBuild, {
      params: { connectionId: build.connectionId }, body: { decisions: [{ object: 'projects', accept: true }, { object: 'tasks', accept: false }] },
    }, { ...cell.as(member), idempotencyKey: uuidv7() });
    assert.deepEqual(out.stages.slice(-2).map((s) => `${s.stage}:${s.status}`), ['confirm:completed', 'verify:failed']);
    assert.equal(out.connectionStatus, 'probing');
    assert.deepEqual((out.stages.at(-2)!.findings as { rejected: string[] }).rejected, ['tasks']);
  });

  test('someone else\'s build is theirs: refused without connection.manage where it is owned', async () => {
    const other = await cell.member('other@acme.example', 'Member', 'sales');
    await assert.rejects(gateway().call(getBuild, { params: { connectionId: build.connectionId } }, cell.as(other)), { code: 'build.not_permitted' });
  });
});

describe('from an address (16.3 inputs 1 to 3)', () => {
  const sandbox = () => ({ name: 'Ledger by address', owningScopeId: cell.scopes['engineering']! });
  test('a specification URL is read by the cell and drafted as the specification it is, without a model', async () => {
    const build = await gateway().call(draftConnector, { body: {
      name: 'Ledger by URL', slug: 'ledger-by-url', provider: 'Example', baseUrl: ledger.url, documentation: { kind: 'url', url: `${ledger.url}/docs/spec` }, sandbox: sandbox(),
    } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    const parse = build.stages[0]!.findings as { source: string; model: boolean; objects: number; fetched: { input: string; url: string } };
    assert.deepEqual([parse.source, parse.model, parse.objects, parse.fetched.input, parse.fetched.url], ['openapi', false, 2, 'url', `${ledger.url}/docs/spec`]);
    await assert.rejects(gateway().call(draftConnector, { body: {
      name: 'Nothing', slug: 'nothing-there', provider: 'Example', documentation: { kind: 'url', url: `${ledger.url}/docs/missing` }, sandbox: sandbox(),
    } }, { ...cell.as(root), idempotencyKey: uuidv7() }), { code: 'build.document_absent' });
  });

  test('a base URL alone: its well-known description addresses are tried, and the first found is drafted', async () => {
    const build = await gateway().call(draftConnector, { body: {
      name: 'Ledger by base', slug: 'ledger-by-base', provider: 'Example', baseUrl: ledger.url, documentation: { kind: 'base_url' }, sandbox: sandbox(),
    } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    const parse = build.stages[0]!.findings as { source: string; objects: number; fetched: { input: string; url: string } };
    assert.deepEqual([parse.source, parse.objects, parse.fetched.input, parse.fetched.url], ['openapi', 2, 'base_url', `${ledger.url}/openapi.json`]);
    await assert.rejects(gateway().call(draftConnector, { body: {
      name: 'Tasks by base', slug: 'tasks-by-base', provider: 'Example', baseUrl: tasks.url, documentation: { kind: 'base_url' }, sandbox: sandbox(),
    } }, { ...cell.as(root), idempotencyKey: uuidv7() }), { code: 'build.parse_no_description' }, 'nothing published: the person gives documentation');
  });

  test('what a document is, from what it says: specifications compiled, documentation for people as text', () => {
    assert.equal(recognise('{"openapi":"3.0.0","paths":{}}', 'application/json', 'https://x.example/a').documentation.kind, 'openapi');
    assert.equal(recognise('swagger: "2.0"\npaths: {}', 'application/yaml', 'https://x.example/a').documentation.kind, 'openapi');
    assert.equal(recognise('<?xml version="1.0"?><edmx:Edmx Version="4.0"></edmx:Edmx>', 'application/xml', 'https://x.example/$metadata').documentation.kind, 'odata');
    assert.equal(recognise('<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"></wsdl:definitions>', 'text/xml', 'https://x.example/?wsdl').documentation.kind, 'wsdl');
    assert.equal(recognise('{"data":{"__schema":{"types":[]}}}', 'application/json', 'https://x.example/g').documentation.kind, 'graphql');
    assert.equal(recognise('type Query { orders: [Order] }', 'text/plain', 'https://x.example/g').documentation.kind, 'graphql');
    const page = recognise('<html><head><title>Orders API</title><script>evil()</script></head><body><h1>Orders</h1><p>GET /orders lists orders.</p></body></html>',
      'text/html', 'https://x.example/docs');
    assert.ok(page.documentation.kind === 'text' && page.documentation.title === 'Orders API' && page.documentation.text.includes('GET /orders lists orders.')
      && !page.documentation.text.includes('evil'), JSON.stringify(page));
    assert.equal(recognise('x'.repeat(30_000), 'text/plain', 'https://x.example/doc.txt').truncated, true);
  });
});
