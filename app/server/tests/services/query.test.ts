// The query path end to end (spec 26, 27): a question or a structured plan, through the
// reader's vocabulary, the model gateway (a fake model), compile's checks, the planner's
// bounds, metering's charge and the executor, against two systems: a REST API (a fake) and
// a SQL database reached through a fake Silo Agent. Real processes: credential, policy,
// auth, connect-registry, ontology, connect-runtime, pushdown-compiler, model-gateway,
// metering, resolution, planner, executor and compile.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { compilePlan, compileQuestion, copyPlanBinding, getCompiledPlan, getVocabulary, runCompiledPlan } from '../../src/contracts/compile/compile.contract.ts';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { readResult, readResultPage, runObjectSet, runPlan, type QueryResult } from '../../src/contracts/executor/result.contract.ts';
import { readObjectView } from '../../src/contracts/executor/objectView.contract.ts';
import { grantAllowance } from '../../src/contracts/metering/allowance.contract.ts';
import { putFunction, putInterface, putLinkType, putObjectType, putSharedProperty } from '../../src/contracts/ontology/element.contract.ts';
import { getManifest, type OntologyManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { approveProposal, mergeProposal, openBranch, submitProposal } from '../../src/contracts/ontology/proposal.contract.ts';
import type { QueryPlanInput } from '../../src/contracts/planner/plan.contract.ts';
import { applyMarking, createFieldPolicy, createMarking, grantClearance, grantConnection } from '../../src/contracts/policy/governance.contract.ts';
import { DEFAULT_ADMIN_URL, urlFor } from '../../src/db/scripts/bootstrapLocal.script.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { service as compileService } from '../../src/routes/compile/index.route.ts';
import { getOrganisationCalendar, setOrganisationCalendar } from '../../src/contracts/compile/calendar.contract.ts';
import { service as simulationService } from '../../src/routes/simulation/index.route.ts';
import { createAskService } from '../../src/routes/ask/index.route.ts';
import { askQuestion, createThread, rerunTurn } from '../../src/contracts/ask/thread.contract.ts';
import { createAnalysisFromTurn, readAnalysis, runAnalysis as runWorkspaceAnalysis } from '../../src/contracts/workspace/analysis.contract.ts';
import { createWorkspaceService } from '../../src/routes/workspace/index.route.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as executorService } from '../../src/routes/executor/index.route.ts';
import { createMeteringService } from '../../src/routes/metering/index.route.ts';
import { service as modelGatewayService } from '../../src/routes/model-gateway/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { service as plannerService } from '../../src/routes/planner/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import { service as resolutionService } from '../../src/routes/resolution/index.route.ts';
import { bumpChangeEpochs } from '../../src/infra/keyspaces.infra.ts';
import { embeddingsReply } from './embedding.helper.ts';
import { connectRedis, type RedisStore } from '../../src/infra/redis.infra.ts';
import { loadRedisConfig } from '../../src/config/redis.config.ts';
import { SourceSqlError, type AgentChannel } from '../../src/services/connect-runtime/agent.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

const SOURCE_ROWS = 50;
const RESULT_ROWS = 25;

let cell: ConnectCell;
let askRunning = false;
let gateway: ServiceClient;
let compileCaller: ServiceClient;
let root: Signed;
let editor: Signed;
let viewer: Signed;
let crm: string;
let ledger: string;
let api: Server;
let baseUrl: string;
const apiRequests: URL[] = [];
let modelServer: Server;
const modelRequests: { body: any }[] = [];
const modelReplies: unknown[] = [];
/** The texts each embeddings request carried (decision 2026-11-15). */
const embedded: string[][] = [];
let customer: pg.Client;
const customerDb = `ledger_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
let dir: string;
let manifest: OntologyManifest;

const SUPPLIERS = [
  { id: 's1', name: 'Acme Ltd', region: 'north', reg_no: 'R1' },
  { id: 's2', name: 'Brill plc', region: 'south', reg_no: 'R2' },
  { id: 's3', name: 'Cobalt', region: 'north', reg_no: 'R3' },
  { id: 's4', name: 'Delta', region: 'east', reg_no: ' R4 ' },
  { id: 's5', name: 'Echo', region: 'south', reg_no: null },
];
const INVOICES = [
  { id: 'i1', supplier_id: 's1', total: 120, status: 'open', issued_on: '2026-01-15' },
  { id: 'i2', supplier_id: 's1', total: 80, status: 'paid', issued_on: '2026-02-10' },
  { id: 'i3', supplier_id: 's2', total: 300, status: 'open', issued_on: '2026-03-05' },
  { id: 'i4', supplier_id: 's3', total: 50, status: 'open', issued_on: '2025-12-20' },
  { id: 'i5', supplier_id: 's4', total: 200, status: 'paid', issued_on: '2026-01-30' },
  { id: 'i6', supplier_id: 's3', total: 75, status: 'paid', issued_on: '2026-02-14' },
];
const NOTES = Array.from({ length: 40 }, (_, i) => ({ id: `n${String(i + 1).padStart(2, '0')}`, body: `note ${i + 1}` }));
const EVENTS = Array.from({ length: 80 }, (_, i) => ({ id: `e${i + 1}`, kind: 'tick' }));

const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });
const source = (p: string) => ({ kind: 'rest', request: { method: 'GET', path: p, query: {} }, records: { jsonata: 'results' } });

// ----------------------------------------------------------------------------- the ontology, as ids

const type = (apiName: string) => manifest.objectTypes.find((t) => t.apiName === apiName)!;
const prop = (typeName: string, apiName: string) => type(typeName).properties.find((p) => p.apiName === apiName)!.identityId;
const link = (apiName: string) => manifest.linkTypes.find((l) => l.apiName === apiName)!;

function plan(body: Omit<QueryPlanInput, 'schemaVersion' | 'ontologyVersionId'>): QueryPlanInput {
  return { schemaVersion: '1', ontologyVersionId: manifest.version.id, ...body };
}

async function run(who: Signed, p: QueryPlanInput, parameters: Record<string, unknown> = {}) {
  return gateway.call(compilePlan, { body: { plan: p, parameters: parameters as never } }, cell.as(who));
}

function answer(out: { outcome: string }): QueryResult {
  assert.equal(out.outcome, 'answer', JSON.stringify(out).slice(0, 600));
  return (out as unknown as { result: QueryResult }).result;
}

const values = (r: QueryResult, name: string) => r.page.objects.map((o) => o.values[name]);

// ----------------------------------------------------------------------------- the cell

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    apiRequests.push(url);
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer tok_valid') {
      res.statusCode = 401;
      res.end('{}');
      return;
    }
    let rows: Record<string, unknown>[] = [];
    if (url.pathname === '/v1/suppliers') rows = SUPPLIERS.filter((s) => !url.searchParams.has('region') || s.region === url.searchParams.get('region'));
    if (url.pathname === '/v1/invoices') {
      rows = INVOICES.filter((i) => (!url.searchParams.has('status') || i.status === url.searchParams.get('status'))
        && (!url.searchParams.has('from') || i.issued_on >= url.searchParams.get('from')!)
        && (!url.searchParams.has('to') || i.issued_on < url.searchParams.get('to')!));
    }
    if (url.pathname === '/v1/notes') rows = NOTES;
    if (url.pathname === '/v1/events') rows = EVENTS;
    res.end(JSON.stringify({ results: rows }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

  modelServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/v1/embeddings') {
        embedded.push(Array.isArray(body.input) ? body.input : [body.input]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(embeddingsReply(body)));
        return;
      }
      modelRequests.push({ body });
      const output = modelReplies.shift() ?? { outcome: 'unanswerable', reason: 'not_a_question' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'open-weights-test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }));
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  dir = mkdtempSync(path.join(tmpdir(), 'silo-query-'));
  const tokenFile = path.join(dir, 'token');
  writeFileSync(tokenFile, 'model-token\n');
  const modelUrl = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}`;
  const routesFile = path.join(dir, 'routes.json');
  writeFileSync(routesFile, JSON.stringify(['compile', 'compile_advanced', 'embedding'].map((role) => ({
    role, provider: 'self_hosted', endpoint: modelUrl, model: role === 'embedding' ? 'embedding-test' : 'open-weights-test', region: 'uk-lon-1',
    zeroRetention: true, auth: { kind: 'bearer_file', file: tokenFile }, maxOutputTokens: 4096, ...(role === 'embedding' ? { embedBatch: 50 } : {}),
  }))));

  // The ledger: a customer's database, reached only through the agent.
  const admin = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${customerDb}`);
  await admin.end();
  customer = new pg.Client({ connectionString: urlFor(DEFAULT_ADMIN_URL, customerDb) });
  await customer.connect();
  await customer.query(`
    create schema books;
    create table books.vendors (code text primary key, vendor_name text, registration text, rating integer);
    insert into books.vendors values ('V1', 'Acme Ltd', 'R1', 5), ('V2', 'Brill Limited', 'R2', 3), ('V4', 'Delta', 'R4', 4), ('V9', 'Zulu', 'R9', 2);
    create table books.regions (code text primary key, region_name text);
    insert into books.regions values ('N', 'North'), ('S', 'South'), ('E', 'East');
    create table books.vendor_regions (vendor_code text references books.vendors (code), region_code text references books.regions (code));
    insert into books.vendor_regions values ('V1', 'N'), ('V1', 'S'), ('V2', 'N'), ('V4', 'E');`);

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
  const bounds = { EXECUTOR_MAX_ROWS_PER_SOURCE_STEP: String(SOURCE_ROWS), EXECUTOR_MAX_RESULT_ROWS: String(RESULT_ROWS) };
  // The gateway first: ontology embeds descriptions through it (decision 2026-11-15).
  await cell.start(modelGatewayService, 'model-gateway', 'test_model_gateway' as never, { MODEL_ROUTES_FILE: routesFile });
  await cell.start(ontologyService, 'ontology', 'test_app');
  await cell.start(createConnectRuntimeService({ agent }), 'connect-runtime', 'test_app', bounds);
  await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
  await cell.start(createMeteringService(), 'metering', 'test_app', { DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: LOCAL.natsUrl });
  await cell.start(resolutionService, 'resolution', 'test_app');
  // The object view lists Action types (34.5): actions runs before the executor, as in production.
  await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app');
  await cell.start(plannerService, 'planner', 'test_app', bounds);
  await cell.start(executorService, 'executor', 'test_app', bounds);
  await cell.start(compileService, 'compile', 'test_app', bounds);
  gateway = cell.client('gateway');
  compileCaller = cell.client('compile');
  root = await cell.signIn('root@acme.example');
  editor = await cell.member('editor@acme.example', 'Super admin');
  viewer = await cell.member('viewer@acme.example', 'Member');

  // Two systems, active.
  const activate = async (slug: string, document: Record<string, never>, secrets: Record<string, string>, agentPoolId?: string) => {
    const connector = await gateway.call(createConnector, { body: { slug, name: slug, provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } }, keyed(root));
    let connection = await gateway.call(createConnection, {
      body: { connectorId: connector.id, name: slug, owningScopeId: cell.scopes['engineering']!, ...(agentPoolId ? { agentPoolId } : {}) },
    }, keyed(root));
    if (Object.keys(secrets).length > 0) await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: secrets } }, cell.as(root));
    for (const move of ['probe', 'confirm', 'activate'] as const) {
      if (move === 'confirm') await cell.passConformance(connection.id);
      connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
    }
    return connection.id;
  };
  crm = await activate('crm', doc({
    schemaVersion: '1', identity: { name: 'Accounts', provider: 'Example', version: '1.0.0' },
    transport: { viaAgent: false, baseUrl }, protocol: { kind: 'rest' },
    auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
    objects: [
      { name: 'suppliers', identifier: ['id'], source: source('/v1/suppliers'),
        fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'name', type: 'string' }, { name: 'region', type: 'string' }, { name: 'reg_no', type: 'string' }],
        pushdown: { filters: [{ field: 'region', ops: ['eq'], patch: { cel: '{"query": {"region": string(value)}}' } }] } },
      { name: 'invoices', identifier: ['id'], source: source('/v1/invoices'),
        fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'supplier_id', type: 'string' }, { name: 'total', type: 'number' },
          { name: 'status', type: 'string' }, { name: 'issued_on', type: 'date' }],
        relationships: [{ field: 'supplier_id', targetObject: 'suppliers', targetField: 'id', kind: 'foreign_key' }],
        pushdown: { filters: [
          { field: 'status', ops: ['eq'], patch: { cel: '{"query": {"status": string(value)}}' } },
          { field: 'issued_on', ops: ['gte', 'lt'], patch: { cel: 'op == "gte" ? {"query": {"from": string(value)}} : {"query": {"to": string(value)}}' } },
        ] } },
      { name: 'notes', identifier: ['id'], source: source('/v1/notes'), fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'body', type: 'string' }] },
      { name: 'events', identifier: ['id'], source: source('/v1/events'), fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'kind', type: 'string' }] },
    ],
  }), { token: 'tok_valid' });
  const pool = uuidv7();
  await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `insert into connect.agent_pools (id, organisation_id, name, created_by) values ($1, $2, 'Office', $3)`, [pool, cell.org, root.membershipId]));
  ledger = await activate('ledger', doc({
    schemaVersion: '1', identity: { name: 'Ledger', provider: 'Example', version: '2.1.0' },
    transport: { viaAgent: true }, protocol: { kind: 'sql', dialect: 'postgres' },
    auth: { strategy: 'username_password', fields: [{ name: 'username', kind: 'public', label: 'User', role: 'username' }, { name: 'password', kind: 'secret', label: 'Password', role: 'password' }] },
    objects: [{
      name: 'vendors', identifier: ['code'], source: { kind: 'sql', schema: 'books', table: 'vendors' },
      fields: [{ name: 'code', type: 'string', nullable: false }, { name: 'vendor_name', type: 'string' }, { name: 'registration', type: 'string' }, { name: 'rating', type: 'integer' }],
      pushdown: { filters: [{ field: 'rating', ops: ['eq', 'gt', 'gte', 'lt', 'lte'] }, { field: 'code', ops: ['eq', 'in'] }], aggregates: { functions: ['count', 'sum', 'min', 'max', 'avg'], groupBy: true } },
    }, {
      name: 'regions', identifier: ['code'], source: { kind: 'sql', schema: 'books', table: 'regions' },
      fields: [{ name: 'code', type: 'string', nullable: false }, { name: 'region_name', type: 'string' }],
      pushdown: { filters: [{ field: 'code', ops: ['eq', 'in'] }], aggregates: { functions: ['count', 'sum', 'min', 'max', 'avg'], groupBy: true } },
    }, {
      name: 'vendor_regions', identifier: ['vendor_code', 'region_code'], source: { kind: 'sql', schema: 'books', table: 'vendor_regions' },
      fields: [{ name: 'vendor_code', type: 'string', nullable: false }, { name: 'region_code', type: 'string', nullable: false }],
      pushdown: { filters: [{ field: 'vendor_code', ops: ['eq', 'in'] }] },
      relationships: [
        { field: 'vendor_code', targetObject: 'vendors', targetField: 'code', kind: 'foreign_key' },
        { field: 'region_code', targetObject: 'regions', targetField: 'code', kind: 'foreign_key' },
      ],
    }],
  }), {}, pool);

  // The ontology: suppliers in both systems (resolved by registration), invoices, notes, events.
  const branch = await gateway.call(openBranch, { body: { name: 'finance' } }, keyed(editor));
  const put = (apiName: string, body: object) => gateway.call(putObjectType, { params: { branchId: branch.id, apiName }, body: body as never }, keyed(editor));
  const m = (connectionId: string, sourceObject: string, fieldPath: string) => ({ connectionId, sourceObject, fieldPath });
  await put('supplier', {
    displayName: 'Supplier', pluralName: 'Suppliers',
    contributingObjects: [{ connectionId: crm, sourceObject: 'suppliers', identifierFieldPath: 'id' }, { connectionId: ledger, sourceObject: 'vendors', identifierFieldPath: 'code' }],
    properties: [
      { apiName: 'name', displayName: 'Name', dataType: 'string', mappings: [m(crm, 'suppliers', 'name'), m(ledger, 'vendors', 'vendor_name')] },
      { apiName: 'region', displayName: 'Region', dataType: 'string', mappings: [m(crm, 'suppliers', 'region')] },
      { apiName: 'registration', displayName: 'Registration', dataType: 'string', mappings: [m(crm, 'suppliers', 'reg_no'), m(ledger, 'vendors', 'registration')] },
      { apiName: 'rating', displayName: 'Rating', dataType: 'integer', mappings: [m(ledger, 'vendors', 'rating')] },
    ],
    title: 'name', matchKeys: [{ property: 'registration', normalisation: 'value.trim()' }],
  });
  // An interface (spec 21.9): anything with a label. Vendors and regions implement it.
  await gateway.call(putSharedProperty, { params: { branchId: branch.id, apiName: 'label' }, body: { displayName: 'Label', dataType: 'string' } as never }, keyed(editor));
  await gateway.call(putInterface, { params: { branchId: branch.id, apiName: 'labelled' }, body: { displayName: 'Labelled', requiredSharedProperties: ['label'] } as never }, keyed(editor));
  await put('vendor', {
    displayName: 'Vendor', pluralName: 'Vendors', implements: [{ interface: 'labelled', propertyBindings: { label: 'vendor_name' } }],
    contributingObjects: [{ connectionId: ledger, sourceObject: 'vendors', identifierFieldPath: 'code' }],
    properties: [
      { apiName: 'code', displayName: 'Code', dataType: 'string', nullable: false, mappings: [m(ledger, 'vendors', 'code')] },
      { apiName: 'vendor_name', displayName: 'Name', dataType: 'string', mappings: [m(ledger, 'vendors', 'vendor_name')] },
      { apiName: 'rating', displayName: 'Rating', dataType: 'integer', mappings: [m(ledger, 'vendors', 'rating')] },
    ],
    primaryKey: 'code', title: 'vendor_name',
  });
  await put('invoice', {
    displayName: 'Invoice', pluralName: 'Invoices',
    contributingObjects: [{ connectionId: crm, sourceObject: 'invoices', identifierFieldPath: 'id' }],
    properties: [
      { apiName: 'invoice_id', displayName: 'Invoice number', dataType: 'string', mappings: [m(crm, 'invoices', 'id')] },
      { apiName: 'total', displayName: 'Total', dataType: 'decimal', mappings: [m(crm, 'invoices', 'total')] },
      { apiName: 'status', displayName: 'Status', dataType: 'string', mappings: [m(crm, 'invoices', 'status')] },
      { apiName: 'issued_on', displayName: 'Issued on', dataType: 'date', mappings: [m(crm, 'invoices', 'issued_on')] },
      { apiName: 'supplier_ref', displayName: 'Supplier', dataType: 'string', mappings: [m(crm, 'invoices', 'supplier_id')] },
    ],
    primaryKey: 'invoice_id', title: 'invoice_id', timeFields: [{ property: 'issued_on', meaning: 'issued', isDefault: true }],
  });
  // A computed property (spec 21.11): an invoice's total with VAT, from its own total.
  const vat = await gateway.call(putFunction, {
    params: { branchId: branch.id, apiName: 'total_with_vat' },
    body: {
      kind: 'computed_property', description: 'The total with VAT at 20%', expression: 'double(object.total) * 1.2',
      inputs: { properties: [{ objectType: 'invoice', property: 'total' }] }, outputType: { dataType: 'decimal' },
    } as never,
  }, keyed(editor));
  await put('invoice', {
    displayName: 'Invoice', pluralName: 'Invoices',
    contributingObjects: [{ connectionId: crm, sourceObject: 'invoices', identifierFieldPath: 'id' }],
    properties: [
      { apiName: 'invoice_id', displayName: 'Invoice number', dataType: 'string', mappings: [m(crm, 'invoices', 'id')] },
      { apiName: 'total', displayName: 'Total', dataType: 'decimal', mappings: [m(crm, 'invoices', 'total')] },
      { apiName: 'status', displayName: 'Status', dataType: 'string', mappings: [m(crm, 'invoices', 'status')] },
      { apiName: 'issued_on', displayName: 'Issued on', dataType: 'date', mappings: [m(crm, 'invoices', 'issued_on')] },
      { apiName: 'supplier_ref', displayName: 'Supplier', dataType: 'string', mappings: [m(crm, 'invoices', 'supplier_id')] },
      { apiName: 'total_with_vat', displayName: 'Total with VAT', dataType: 'decimal', computedFunctionVersionId: vat.element.version.id },
    ],
    primaryKey: 'invoice_id', title: 'invoice_id', timeFields: [{ property: 'issued_on', meaning: 'issued', isDefault: true }],
  });
  await put('region', {
    displayName: 'Region', pluralName: 'Regions', implements: [{ interface: 'labelled', propertyBindings: { label: 'region_name' } }],
    contributingObjects: [{ connectionId: ledger, sourceObject: 'regions', identifierFieldPath: 'code' }],
    properties: [
      { apiName: 'region_code', displayName: 'Code', dataType: 'string', nullable: false, mappings: [m(ledger, 'regions', 'code')] },
      { apiName: 'region_name', displayName: 'Name', dataType: 'string', mappings: [m(ledger, 'regions', 'region_name')] },
    ],
    primaryKey: 'region_code', title: 'region_name',
  });
  for (const [apiName, object, field] of [['note', 'notes', 'body'], ['event', 'events', 'kind']] as const) {
    await put(apiName, {
      displayName: apiName, pluralName: `${apiName}s`, contributingObjects: [{ connectionId: crm, sourceObject: object, identifierFieldPath: 'id' }],
      properties: [
        { apiName: `${apiName}_id`, displayName: 'Id', dataType: 'string', mappings: [m(crm, object, 'id')] },
        { apiName: field, displayName: field, dataType: 'string', mappings: [m(crm, object, field)] },
      ],
      primaryKey: `${apiName}_id`, title: `${apiName}_id`,
    });
  }
  await gateway.call(putLinkType, {
    params: { branchId: branch.id, apiName: 'supplier_invoices' },
    body: { forwardName: 'billed', reverseName: 'billed by', from: 'supplier', to: 'invoice', cardinality: 'one_to_many',
      routes: [{ connectionId: crm, sourceObject: 'invoices', foreignKeyField: 'supplier_id', referencedField: 'id', origin: 'declared_fk' }], defaultRoute: 0 },
  }, keyed(editor));
  // Many-to-many through the ledger's junction (spec 21.8): the route names its key to vendors; its key to regions is declared.
  await gateway.call(putLinkType, {
    params: { branchId: branch.id, apiName: 'vendor_regions' },
    body: { forwardName: 'serves', reverseName: 'served by', from: 'vendor', to: 'region', cardinality: 'many_to_many',
      routes: [{ connectionId: ledger, sourceObject: 'vendors', foreignKeyField: 'vendor_code', referencedField: 'code', junctionObject: 'vendor_regions', origin: 'declared_fk' }],
      defaultRoute: 0 },
  }, keyed(editor));
  const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Finance' } }, keyed(editor));
  await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
  await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
  manifest = await gateway.call(getManifest, { query: {} }, cell.as(root));

  // What billing writes from a verified subscription, so compile can be charged.
  const subscription = uuidv7();
  await inTx(cell.app, { orgId: cell.org }, async () => {
    await cell.app.query(
      `insert into billing.subscriptions (id, organisation_id, plan, seat_count, term, discount_tier, stripe_customer_id, stripe_subscription_id,
         current_period_start, current_period_end, status)
       values ($1, $2, 'business', 10, 'monthly', 'list', 'cus_q', $3, now() - interval '1 day', now() + interval '29 days', 'active')`,
      [subscription, cell.org, `sub_${uuidv7().slice(-12)}`]);
    await cell.app.query(
      `insert into billing.entitlements (id, organisation_id, seats, tokens_per_seat_period, simulations_per_seat_period, daily_token_limit,
         storage_included_bytes, capabilities, source, subscription_id, effective_from)
       values ($1, $2, 10, 1000, 5, 40, 0, '{sso}', 'subscription', $3, now())`, [uuidv7(), cell.org, subscription]);
    for (const who of [root, viewer]) {
      await cell.app.query(`insert into billing.seats (id, organisation_id, subscription_id, membership_id, plan_tier, status) values ($1, $2, $3, $4, 'business', 'assigned')`,
        [uuidv7(), cell.org, subscription, who.membershipId]);
    }
  });
  for (const who of [root, viewer]) await cell.client('auth').call(grantAllowance, { body: { membershipId: who.membershipId } }, cell.as(who));
});

after(async () => {
  await cell?.close();
  api?.close();
  modelServer?.close();
  await customer?.end();
  const admin = new pg.Client({ connectionString: DEFAULT_ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${customerDb} with (force)`);
  await admin.end();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------- tests

describe('a structured plan (spec 26.2, 27.2 to 27.4)', () => {
  let first: QueryResult;
  const openSince = () => plan({
    nodes: [{
      objectTypeId: type('invoice').id,
      filters: [{ property: prop('invoice', 'status'), op: 'eq', value: { param: 'p1' } }],
      period: { property: prop('invoice', 'issued_on'), asWritten: 'this year so far', expression: { kind: 'between', from: { param: 'p2' }, to: { param: 'p3' } } },
    }],
    select: [{ node: 0, property: prop('invoice', 'invoice_id') }, { node: 0, property: prop('invoice', 'total') }],
    sort: [{ property: prop('invoice', 'total'), direction: 'desc' }],
  });
  const params = { p1: 'open', p2: '2026-01-01', p3: '2026-04-01' };

  test('filters and the period are pushed to the system; it reads only the mapped fields; the answer is ordered after merge', async () => {
    const before = apiRequests.length;
    first = answer(await run(root, openSince(), params));
    assert.deepEqual(values(first, 'invoice_id'), ['i3', 'i1']);
    assert.deepEqual(values(first, 'total'), [300, 120]);
    const call = apiRequests.slice(before).find((u) => u.pathname === '/v1/invoices')!;
    assert.equal(call.searchParams.get('status'), 'open');
    assert.equal(call.searchParams.get('from'), '2026-01-01');
    assert.equal(call.searchParams.get('to'), '2026-04-01');
    assert.deepEqual(first.localFilters, []);
    assert.equal(first.periods[0]!.from, '2026-01-01');
    assert.equal(first.periods[0]!.to, '2026-04-01');
    assert.equal(first.periods[0]!.basis, 'date');
    assert.equal(first.periods[0]!.defaultTimeField, true);
    assert.deepEqual(first.defaults.timeFields, [{ node: 0, property: prop('invoice', 'issued_on') }]);
  });

  test('lineage on every column: type version, ontology version, system, field, connector version and what the source computed', () => {
    const total = first.lineage.find((l) => l.propertyApiName === 'total')!;
    assert.equal(total.objectTypeVersionId, type('invoice').typeVersionId);
    assert.equal(total.ontologyVersionId, manifest.version.id);
    assert.deepEqual(total.sources.map((s) => [s.connectionId, s.sourceObject, s.fieldPath, s.connectorVersion, s.pushdown.filter]),
      [[crm, 'invoices', 'total', '1.0.0', true]]);
    assert.equal(total.period!.asWritten, 'this year so far');
    assert.deepEqual(total.coverage, { values: 2, empty: 0, disputed: 0, unchecked: 0, masked: 0, redacted: 0 });
  });

  test('the stored plan holds placeholders, never the values', async () => {
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select manifest::text as manifest, period_expressions::text as periods, compile_class from ontology.compiled_manifests where organisation_id = $1`, [cell.org]));
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.ok(!row.manifest.includes('open') && !row.manifest.includes('2026-01-01'), 'no literal in the stored plan');
      assert.match(row.manifest, /"param":\s*"p1"/);
    }
  });

  test('the same plan for the same permissions answers from the cache, without reading any system again', async () => {
    const before = apiRequests.length;
    const again = answer(await run(root, openSince(), params));
    assert.equal(again.cached, true);
    assert.equal(again.queryId, first.queryId);
    assert.deepEqual(values(again, 'invoice_id'), ['i3', 'i1']);
    assert.equal(apiRequests.length, before);
  });

  test('a change to a system the plan read makes the cached result a miss (spec 24.6)', async () => {
    const data: RedisStore = await connectRedis('data', loadRedisConfig({ REDIS_DATA_URL: `${LOCAL.redisUrl}/1` }, [])!);
    try {
      await bumpChangeEpochs(data, cell.org, [{ connectionId: crm, sourceObject: 'invoices' }]);
      const before = apiRequests.length;
      const fresh = answer(await run(root, openSince(), params));
      assert.equal(fresh.cached, false, 'read again');
      assert.notEqual(fresh.queryId, first.queryId);
      assert.ok(apiRequests.length > before);
      assert.equal(answer(await run(root, openSince(), params)).cached, true, 'and cached again until the next change');
      await bumpChangeEpochs(data, cell.org, [{ connectionId: ledger, sourceObject: 'vendors' }]);
      assert.equal(answer(await run(root, openSince(), params)).cached, true, 'a change elsewhere leaves it be');
    } finally {
      await data.close();
    }
  });

  test('a result\'s pages are its own actor\'s', async () => {
    const page = await gateway.call(readResultPage, { params: { queryId: first.queryId, page: 0 } }, cell.as(root));
    assert.deepEqual(page.objects.map((o) => o.values['invoice_id']), ['i3', 'i1']);
    await assert.rejects(gateway.call(readResultPage, { params: { queryId: first.queryId, page: 0 } }, cell.as(viewer)), { code: 'query.result_gone' });
    const again = await gateway.call(readResult, { params: { queryId: first.queryId } }, cell.as(root));
    assert.deepEqual([again.queryId, again.kind, again.population, again.cached, again.page.objects.map((o) => o.values['invoice_id'])],
      [first.queryId, first.kind, first.population, true, ['i3', 'i1']], 'the header and first page again, with nothing run');
    assert.deepEqual(again.columns, first.columns);
    assert.deepEqual(again.lineage, first.lineage);
    await assert.rejects(gateway.call(readResult, { params: { queryId: first.queryId } }, cell.as(viewer)), { code: 'query.result_gone' });
  });
});

describe('pushdown and exact local filters (spec 26.6, 27.3)', () => {
  test('a filter the system cannot apply is applied after the read where exact, and the answer says so', async () => {
    const out = answer(await run(root, plan({
      nodes: [{ objectTypeId: type('invoice').id, filters: [{ property: prop('invoice', 'total'), op: 'gt', value: { param: 'p1' } }] }],
      select: [{ node: 0, property: prop('invoice', 'invoice_id') }],
      sort: [{ property: prop('invoice', 'total'), direction: 'asc' }],
    }), { p1: 100 }));
    assert.deepEqual(values(out, 'invoice_id'), ['i1', 'i5', 'i3']);
    assert.deepEqual(out.localFilters, [{ node: 0, connectionId: crm, field: 'total', op: 'gt' }]);
  });

  test('a filter neither the system nor the engine applies exactly is refused, naming the property', async () => {
    const out = await run(root, plan({
      nodes: [{ objectTypeId: type('invoice').id, filters: [{ property: prop('invoice', 'status'), op: 'contains', value: { param: 'p1' } }] }],
    }), { p1: 'op' });
    assert.equal(out.outcome, 'refusal');
    assert.equal((out as any).refusal.code, 'plan.filter_not_supported');
    assert.equal((out as any).refusal.element.name, 'status');
  });

  test('a value of the wrong type, or a missing parameter, is refused before anything runs', async () => {
    const p = plan({ nodes: [{ objectTypeId: type('invoice').id, filters: [{ property: prop('invoice', 'total'), op: 'gt', value: { param: 'p1' } }] }] });
    assert.equal(((await run(root, p, { p1: 'lots' })) as any).refusal.code, 'plan.filter_value_type');
    assert.equal(((await run(root, p, {})) as any).refusal.code, 'plan.parameter_missing');
  });
});

describe('merge across systems (spec 27.6, 23)', () => {
  test('records with equal normalised match keys are one object; disagreement is a dispute, sorted last; a record without a key stands alone', async () => {
    const out = answer(await run(root, plan({
      nodes: [{ objectTypeId: type('supplier').id }],
      select: [{ node: 0, property: prop('supplier', 'name') }, { node: 0, property: prop('supplier', 'region') }, { node: 0, property: prop('supplier', 'rating') }],
      sort: [{ property: prop('supplier', 'name'), direction: 'asc' }],
    })));
    assert.deepEqual(values(out, 'name'), ['Acme Ltd', 'Cobalt', 'Delta', 'Echo', 'Zulu', null]);
    const brill = out.page.objects.at(-1)!;
    assert.deepEqual(brill.disputed, ['name'], 'Brill plc and Brill Limited disagree: no value, disputed');
    assert.deepEqual(brill.states, { name: 'disputed', region: 'only', rating: 'only' }, 'each value says how it was decided');
    assert.equal(brill.values['region'], 'south');
    assert.equal(brill.values['rating'], 3, 'the ledger alone holds the rating');
    const delta = out.page.objects.find((o) => o.values['name'] === 'Delta')!;
    assert.equal(delta.values['rating'], 4, '" R4 " and "R4" are one key once trimmed');
    assert.equal(out.page.objects.find((o) => o.values['name'] === 'Echo')!.unmatched, true);
    assert.equal(out.coverage.unmatched, 1);
    assert.equal(out.coverage.disputed['name'], 1);
    assert.equal(out.coverage.empty['region'], 1, 'Zulu is only in the ledger, which has no region');
    const name = out.lineage.find((l) => l.propertyApiName === 'name')!;
    assert.deepEqual(name.sources.map((s) => [s.connectionId, s.fieldPath]), [[crm, 'name'], [ledger, 'vendor_name']]);
    // The id is derived: the same object, the same id, every time.
    const again = answer(await run(root, plan({ nodes: [{ objectTypeId: type('supplier').id }], select: [{ node: 0, property: prop('supplier', 'name') }] })));
    assert.equal(again.page.objects.find((o) => o.values['name'] === 'Delta')!.id, delta.id);
  });

  test('a filter on a resolvable type applies to decided values after merge', async () => {
    const out = answer(await run(root, plan({
      nodes: [{ objectTypeId: type('supplier').id, filters: [{ property: prop('supplier', 'region'), op: 'eq', value: { param: 'p1' } }] }],
      select: [{ node: 0, property: prop('supplier', 'name') }], sort: [{ property: prop('supplier', 'name'), direction: 'asc' }],
    }), { p1: 'north' }));
    assert.deepEqual(values(out, 'name'), ['Acme Ltd', 'Cobalt']);
    const filtered = answer(await run(root, plan({
      nodes: [{ objectTypeId: type('supplier').id, filters: [{ property: prop('supplier', 'name'), op: 'starts_with', value: { param: 'p1' } }] }],
      select: [{ node: 0, property: prop('supplier', 'name') }],
    }), { p1: 'Bri' }));
    assert.equal(filtered.total, 0, 'Brill\'s name is disputed, so it is undecided, not a match');
    assert.equal(filtered.coverage.excludedByDispute, 1);
  });
});

describe('joins (spec 26.11, 27.5)', () => {
  test('linked objects come back paired with their object; a filtered linked node narrows its parent', async () => {
    const out = answer(await run(root, plan({
      nodes: [
        { objectTypeId: type('supplier').id },
        { objectTypeId: type('invoice').id, filters: [{ property: prop('invoice', 'status'), op: 'eq', value: { param: 'p1' } }] },
      ],
      hops: [{ from: 0, to: 1, linkTypeId: link('supplier_invoices').id, routeId: link('supplier_invoices').routes[0]!.id }],
      select: [{ node: 0, property: prop('supplier', 'region') }, { node: 1, property: prop('invoice', 'invoice_id') }],
      sort: [{ property: prop('supplier', 'region'), direction: 'asc' }],
    }), { p1: 'open' }));
    const pairs = out.page.objects.map((o) => `${o.values['region']}:${o.links['0']!.map((i) => i.values['invoice_id']).join(',')}`).sort();
    assert.deepEqual(pairs, ['north:i1', 'north:i4', 'south:i3']);
    const route = out.lineage.find((l) => l.node === 1)!.route;
    assert.deepEqual(route, [{ linkTypeId: link('supplier_invoices').id, routeId: link('supplier_invoices').routes[0]!.id }]);
  });

  test('a required linked node narrows its parent with no filter of its own: suppliers with an invoice (37.8)', async () => {
    const suppliers = (required: boolean) => plan({
      nodes: [{ objectTypeId: type('supplier').id }, { objectTypeId: type('invoice').id, ...(required ? { required: true } : {}) }],
      hops: [{ from: 0, to: 1, linkTypeId: link('supplier_invoices').id, routeId: link('supplier_invoices').routes[0]!.id }],
      select: [{ node: 0, property: prop('supplier', 'name') }],
    });
    const all = answer(await run(root, suppliers(false)));
    const reaching = answer(await run(root, suppliers(true)));
    assert.ok(all.page.objects.some((o) => o.values['name'] === 'Echo'), 'Echo has no invoice, and is a supplier');
    assert.ok(!reaching.page.objects.some((o) => o.values['name'] === 'Echo'), 'but does not reach one');
    assert.ok(reaching.page.objects.length > 0 && reaching.page.objects.every((o) => (o.links['0'] ?? []).length > 0));
    await assert.rejects(run(root, plan({ nodes: [{ objectTypeId: type('supplier').id, required: true }] })), { category: 'validation' }, 'the root has no parent');
  });

  test('an aggregate over a link counts each linked object once per group (spec 26.11, 27.7)', async () => {
    const out = answer(await run(root, plan({
      nodes: [{ objectTypeId: type('supplier').id }, { objectTypeId: type('invoice').id }],
      hops: [{ from: 0, to: 1, linkTypeId: link('supplier_invoices').id, routeId: link('supplier_invoices').routes[0]!.id }],
      aggregate: {
        groupBy: [{ node: 0, property: prop('supplier', 'region') }],
        measures: [{ fn: 'sum', node: 1, property: prop('invoice', 'total'), as: 'spend' }, { fn: 'count', node: 0, as: 'suppliers' }],
      },
      sort: [{ measure: 'spend', direction: 'desc' }],
    })));
    assert.equal(out.kind, 'groups');
    assert.equal(out.aggregateForm, 'merged');
    assert.deepEqual(out.page.groups.map((g) => [g.key['region'], g.measures['spend'], g.measures['suppliers']]),
      [['north', 325, 2], ['south', 300, 2], ['east', 200, 1], [null, null, 1]]);
  });

  test('partial aggregate pushdown: a single-source type whose source declares it computes per group; the answer says so (spec 27.7)', async () => {
    const pushed = answer(await run(root, plan({
      nodes: [{ objectTypeId: type('vendor').id, filters: [{ property: prop('vendor', 'rating'), op: 'gte', value: { param: 'p1' } }] }],
      aggregate: {
        groupBy: [],
        measures: [
          { fn: 'count', node: 0, as: 'n' }, { fn: 'sum', node: 0, property: prop('vendor', 'rating'), as: 'total' },
          { fn: 'avg', node: 0, property: prop('vendor', 'rating'), as: 'mean' }, { fn: 'min', node: 0, property: prop('vendor', 'rating'), as: 'low' },
          { fn: 'max', node: 0, property: prop('vendor', 'rating'), as: 'high' },
        ],
      },
    }), { p1: 3 }));
    assert.equal(pushed.aggregateForm, 'partial_pushdown');
    assert.deepEqual(pushed.page.groups.map((g) => [g.objects, g.measures]), [[3, { n: 3, total: 12, mean: 4, low: 3, high: 5 }]]);
    assert.equal(pushed.lineage.find((l) => l.propertyApiName === 'rating')!.sources[0]!.pushdown.aggregate, true);
    // A distinct count is never split: over merged objects, and the same figures otherwise.
    const merged = answer(await run(root, plan({
      nodes: [{ objectTypeId: type('vendor').id, filters: [{ property: prop('vendor', 'rating'), op: 'gte', value: { param: 'p1' } }] }],
      aggregate: { groupBy: [], measures: [{ fn: 'count', node: 0, as: 'n' }, { fn: 'count_distinct', node: 0, property: prop('vendor', 'rating'), as: 'kinds' }] },
    }), { p1: 3 }));
    assert.equal(merged.aggregateForm, 'merged');
    assert.deepEqual(merged.page.groups.map((g) => g.measures), [{ n: 3, kinds: 3 }]);
  });

  test('a computed property is computed after merge from its inputs, filtered and sorted on, and traced to them (spec 21.11)', async () => {
    const out = answer(await run(root, plan({
      nodes: [{ objectTypeId: type('invoice').id, filters: [{ property: prop('invoice', 'total_with_vat'), op: 'gt', value: { param: 'p1' } }] }],
      select: [{ node: 0, property: prop('invoice', 'invoice_id') }, { node: 0, property: prop('invoice', 'total_with_vat') }],
      sort: [{ property: prop('invoice', 'total_with_vat'), direction: 'desc' }],
    }), { p1: 150 }));
    const rows = out.page.objects.map((o) => [o.values['invoice_id'], o.values['total_with_vat']]);
    assert.ok(rows.length > 0 && rows.every(([, v]) => typeof v === 'number' && v > 150));
    assert.deepEqual(rows.map(([, v]) => v), [...rows.map(([, v]) => v)].sort((a, b) => (b as number) - (a as number)));
    const lineage = out.lineage.find((l) => l.propertyApiName === 'total_with_vat')!;
    assert.deepEqual(lineage.sources.map((s) => s.fieldPath), ['total'], 'traced to the field it is computed from');
  });

  test('a many-to-many link is followed through its junction, both ways (spec 21.8)', async () => {
    const hop = { from: 0, to: 1, linkTypeId: link('vendor_regions').id, routeId: link('vendor_regions').routes[0]!.id };
    const forward = answer(await run(root, plan({
      nodes: [{ objectTypeId: type('vendor').id }, { objectTypeId: type('region').id }], hops: [hop],
      select: [{ node: 0, property: prop('vendor', 'code') }, { node: 1, property: prop('region', 'region_code') }],
    })));
    const served = Object.fromEntries(forward.page.objects.map((o) => [o.values['code'], (o.links['0'] ?? []).map((r) => r.values['region_code']).sort()]));
    assert.deepEqual(served, { V1: ['N', 'S'], V2: ['N'], V4: ['E'], V9: [] });
    const reverse = answer(await run(root, plan({
      nodes: [{ objectTypeId: type('region').id }, { objectTypeId: type('vendor').id }], hops: [hop],
      select: [{ node: 0, property: prop('region', 'region_code') }, { node: 1, property: prop('vendor', 'code') }],
    })));
    const servedBy = Object.fromEntries(reverse.page.objects.map((o) => [o.values['region_code'], (o.links['0'] ?? []).map((v) => v.values['code']).sort()]));
    assert.deepEqual(servedBy, { N: ['V1', 'V2'], S: ['V1'], E: ['V4'] });
  });

  test('grouped measures on one type', async () => {
    const out = answer(await run(root, plan({
      nodes: [{ objectTypeId: type('invoice').id }],
      aggregate: { groupBy: [{ node: 0, property: prop('invoice', 'status') }], measures: [{ fn: 'count', node: 0, as: 'n' }, { fn: 'avg', node: 0, property: prop('invoice', 'total'), as: 'mean' }] },
      sort: [{ property: prop('invoice', 'status'), direction: 'asc' }],
    })));
    assert.deepEqual(out.page.groups.map((g) => [g.key['status'], g.measures['n'], Math.round(g.measures['mean']!)]), [['open', 3, 157], ['paid', 3, 118]]);
  });

  test('a time series (37.8): totals by the month and the quarter of issue, in the organisation\'s calendar; a bucket on anything but a date or time is refused', async () => {
    const by = (bucket: 'month' | 'quarter') => plan({
      nodes: [{ objectTypeId: type('invoice').id }],
      aggregate: { groupBy: [{ node: 0, property: prop('invoice', 'issued_on'), bucket }], measures: [{ fn: 'sum', node: 0, property: prop('invoice', 'total'), as: 'total' }] },
      sort: [{ property: prop('invoice', 'issued_on'), direction: 'asc' }],
    });
    const months = answer(await run(root, by('month')));
    assert.deepEqual(months.page.groups.map((g) => [g.key['issued_on'], g.measures['total']]),
      [['2025-12-01', 50], ['2026-01-01', 320], ['2026-02-01', 155], ['2026-03-01', 300]]);
    assert.equal(months.columns.find((c) => c.apiName === 'issued_on')?.dataType, 'date', 'a bucket is the first day of its period');
    assert.equal(months.aggregateForm, 'merged', 'computed by the engine, never pushed down');
    const quarters = answer(await run(root, by('quarter')));
    assert.deepEqual(quarters.page.groups.map((g) => [g.key['issued_on'], g.measures['total']]), [['2025-10-01', 50], ['2026-01-01', 775]]);
    const refused = await run(root, plan({
      nodes: [{ objectTypeId: type('invoice').id }],
      aggregate: { groupBy: [{ node: 0, property: prop('invoice', 'status'), bucket: 'month' }], measures: [{ fn: 'count', node: 0, as: 'n' }] },
    }));
    assert.equal(refused.outcome, 'refusal');
    assert.equal((refused as { refusal: { code: string } }).refusal.code, 'plan.bucket_type');
  });
});

describe('bounds: refused, never truncated (spec 26.6, 27.4, 27.8)', () => {
  test('a system returning more rows than one step may read refuses the plan, naming the connection', async () => {
    const out = await run(root, plan({ nodes: [{ objectTypeId: type('event').id }] }));
    assert.equal(out.outcome, 'refusal');
    assert.equal((out as any).refusal.code, 'query.bound_rows_per_source');
    assert.equal((out as any).refusal.bound.connectionId, crm);
  });

  test('an answer larger than one answer may cover is refused; a limit after ordering answers it', async () => {
    const out = await run(root, plan({ nodes: [{ objectTypeId: type('note').id }] }));
    assert.equal((out as any).refusal.code, 'query.bound_merged_result');
    assert.equal((out as any).refusal.bound.observed, 40);
    const top = answer(await run(root, plan({
      nodes: [{ objectTypeId: type('note').id }], select: [{ node: 0, property: prop('note', 'note_id') }],
      sort: [{ property: prop('note', 'note_id'), direction: 'desc' }], limit: 3,
    })));
    assert.deepEqual(values(top, 'note_id'), ['n40', 'n39', 'n38']);
    assert.equal(top.population, 40);
    assert.equal(top.total, 3);
  });

  test('refusals are audited as query events', async () => {
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload->>'event' as event, payload->'detail' as detail from platform.outbox where organisation_id = $1 and event = 'audit_event'
         and payload->>'event' in ('query_refused_bounds', 'query_executed', 'pushdown_local_filter_applied')`, [cell.org]));
    const events = rows.map((r) => r.event as string);
    for (const e of ['query_refused_bounds', 'query_executed', 'pushdown_local_filter_applied']) assert.ok(events.includes(e), e);
    assert.ok(rows.some((r) => r.event === 'query_executed' && r.detail.cached === true));
    // A fresh answer's lineage (27.12): its columns and the systems they came from; a cached answer records none again.
    const { rows: lineage } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'lineage_recorded'`, [cell.org]));
    assert.ok(lineage.length > 0);
    assert.ok(lineage.every((r) => r.detail.columns >= 1 && r.detail.connections >= 1 && typeof r.detail.query_id === 'string'));
    const executedFresh = rows.filter((r) => r.event === 'query_executed' && r.detail.cached !== true).length;
    assert.equal(lineage.length, executedFresh, 'one per fresh answer');
  });
});

describe('the reader\'s vocabulary and field policies (spec 26.3, 57.4)', () => {
  before(async () => {
    for (const connectionId of [crm, ledger]) {
      await gateway.call(grantConnection, { body: { connectionId, grantee: { kind: 'membership', id: viewer.membershipId }, access: 'read' } }, cell.as(root));
    }
    const members = cell.roles['Member']!;
    await gateway.call(createFieldPolicy, { body: { target: { propertyId: prop('supplier', 'name') }, effect: 'mask', appliesTo: { roleId: members } } }, cell.as(root));
    await gateway.call(createFieldPolicy, { body: { target: { propertyId: prop('invoice', 'total') }, effect: 'deny', appliesTo: { roleId: members } } }, cell.as(root));
  });

  test('a denied property is absent from the vocabulary; a masked one is shown but marked', async () => {
    const vocab = await gateway.call(getVocabulary, { query: {} }, cell.as(viewer));
    const invoice = vocab.objectTypes.find((t) => t.apiName === 'invoice')!;
    assert.equal(invoice.properties.some((p) => p.apiName === 'total'), false);
    assert.equal(vocab.objectTypes.find((t) => t.apiName === 'supplier')!.properties.find((p) => p.apiName === 'name')!.effect, 'mask');
    const mine = await gateway.call(getVocabulary, { query: {} }, cell.as(root));
    assert.ok(mine.objectTypes.find((t) => t.apiName === 'invoice')!.properties.some((p) => p.apiName === 'total'));
    // What Explorer shows (spec 34.1): names, the title the reader may see, and links named from each side.
    const supplier = vocab.objectTypes.find((t) => t.apiName === 'supplier')!;
    assert.equal(supplier.pluralName, type('supplier').pluralName);
    assert.equal(supplier.titleProperty, type('supplier').titlePropertyIdentityId);
    // The identifying property names one object in a filter (37.8), where it is visible unshaped.
    assert.equal(invoice.primaryKey, type('invoice').primaryKeyPropertyIdentityId);
    assert.ok(vocab.linkTypes.every((l) => l.forwardName.length > 0 && l.reverseName.length > 0));
    assert.ok(Array.isArray(vocab.interfaces));
  });

  test('a masked value shows its last four characters only, and is never filtered on; a denied one cannot be asked for', async () => {
    const out = answer(await run(viewer, plan({ nodes: [{ objectTypeId: type('supplier').id }], select: [{ node: 0, property: prop('supplier', 'name') }] })));
    const shown = out.page.objects.map((o) => o.values['name']).filter((v) => v !== null).sort();
    assert.deepEqual(shown, ['****', '****', '**** Ltd', '****balt', '****elta'], 'four characters or fewer show nothing');
    assert.equal(out.columns[0]!.effect, 'mask');
    assert.equal(out.reduced, true, 'the answer says the reader\'s access shaped it');
    const filtered = await run(viewer, plan({
      nodes: [{ objectTypeId: type('supplier').id, filters: [{ property: prop('supplier', 'name'), op: 'eq', value: { param: 'p1' } }] }],
    }), { p1: 'Acme Ltd' });
    assert.equal((filtered as any).refusal.code, 'plan.property_not_computable');
    const denied = await run(viewer, plan({ nodes: [{ objectTypeId: type('invoice').id }], select: [{ node: 0, property: prop('invoice', 'total') }] }));
    assert.equal((denied as any).refusal.code, 'plan.property_unavailable');
  });

  test('without a grant on a contributing connection, the type is not available at all', async () => {
    const stranger = await cell.member('stranger@acme.example', 'Member');
    const out = await run(stranger, plan({ nodes: [{ objectTypeId: type('invoice').id }] }));
    assert.equal((out as any).refusal.code, 'plan.object_type_unavailable');
  });
});

describe('a question through the model (spec 26.2 to 26.5, 26.9, 26.10)', () => {
  const invoicePlan = (objectType = 'invoice') => ({
    outcome: 'plan',
    plan: {
      nodes: [{ objectType, filters: [{ property: 'status', op: 'eq', value: 'open' }],
        period: { asWritten: 'this year', expression: { kind: 'between', from: '2026-01-01', to: '2027-01-01' } } }],
      select: [{ node: 0, property: 'invoice_id' }], sort: [{ property: 'issued_on', direction: 'asc' }],
    },
  });
  const ledgerRows = async (correlationId: string) => {
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select operation, weight::text as weight from billing.token_transactions where organisation_id = $1 and correlation_id = $2', [cell.org, correlationId]));
    return rows;
  };

  test('vocabulary → model → compile → plan → bounds → charge → execute: an answer, charged once a plan exists', async () => {
    modelReplies.push(invoicePlan());
    const before = modelRequests.length;
    const out = await gateway.call(compileQuestion, { body: { question: 'Which invoices are open this year?' } }, keyed(root));
    assert.equal(out.outcome, 'answer', JSON.stringify(out).slice(0, 400));
    if (out.outcome !== 'answer') return;
    assert.deepEqual(out.result.page.objects.map((o) => o.values['invoice_id']), ['i1', 'i3']);
    assert.deepEqual(out.parameters, { p1: 'open', p2: '2026-01-01', p3: '2027-01-01' });
    assert.equal(out.compileClass, 'standard');
    assert.equal(out.charge.charged, true);
    assert.deepEqual(await ledgerRows(out.planId), [{ operation: 'compile', weight: '1.0000' }]);
    assert.equal(modelRequests.length, before + 1);
    // The model was told names and types, the calendar and the date; no value of any record.
    const prompt = JSON.stringify(modelRequests.at(-1)!.body);
    for (const name of ['invoice', 'supplier', 'issued_on', 'supplier_invoices']) assert.ok(prompt.includes(name), name);
    for (const value of ['Acme Ltd', 'R1', 'i3', 'tok_valid']) assert.ok(!prompt.includes(value), value);
  });

  test('the model is never told what the reader cannot see', async () => {
    modelReplies.push({ outcome: 'unanswerable', reason: 'outside_vocabulary' });
    const out = await gateway.call(compileQuestion, { body: { question: 'What does each invoice amount to?' } }, keyed(viewer));
    assert.equal(out.outcome, 'refusal');
    const sent = modelRequests.at(-1)!.body.messages.map((m: { content: string }) => m.content).join('\n');
    assert.ok(sent.includes('invoice_id'), 'the viewer\'s vocabulary is sent');
    assert.ok(!sent.includes('total'), 'total is denied to the viewer, so it is never named');
  });

  test('a name nobody offered is refused by name and not charged; a clarification is a finished reply, not charged', async () => {
    modelReplies.push(invoicePlan('purchase_order'));
    const unknown = await gateway.call(compileQuestion, { body: { question: 'Which purchase orders are open?' } }, keyed(root));
    assert.equal(unknown.outcome, 'refusal');
    if (unknown.outcome === 'refusal') assert.equal(unknown.refusal.code, 'compile.object_type_unknown');
    modelReplies.push({ outcome: 'clarification', about: 'object_type', options: ['supplier', 'invoice'] });
    const unclear = await gateway.call(compileQuestion, { body: { question: 'Show me the open ones' } }, keyed(root));
    assert.equal(unclear.outcome, 'clarification');
    if (unclear.outcome === 'clarification') {
      assert.deepEqual(unclear.clarification.options.map((o) => o.id).sort(), [type('invoice').id, type('supplier').id].sort());
    }
  });

  test('one re-prompt after a schema failure, without any data; a retry under the same key replays without a second model call or charge', async () => {
    modelReplies.push({ outcome: 'plan' }, invoicePlan());
    const before = modelRequests.length;
    const key = uuidv7();
    const out = await gateway.call(compileQuestion, { body: { question: 'Open invoices this year, please' } }, { ...cell.as(root), idempotencyKey: key });
    assert.equal(out.outcome, 'answer');
    assert.equal(modelRequests.length, before + 2, 'one re-prompt');
    const again = await gateway.call(compileQuestion, { body: { question: 'Open invoices this year, please' } }, { ...cell.as(root), idempotencyKey: key });
    assert.deepEqual(again, out);
    assert.equal(modelRequests.length, before + 2, 'the retry made no model call');
    if (out.outcome === 'answer') {
      assert.equal((await ledgerRows(out.planId)).length, 2, 'two authored compiles of one plan, each charged once; the retry charged nothing');
      const stored = await gateway.call(getCompiledPlan, { params: { planId: out.planId } }, cell.as(root));
      assert.deepEqual(stored.plan, out.plan);
      // A structured re-run of the stored plan is never metered.
      const rerun = await compileCaller.call(runPlan, { body: { plan: stored.plan, parameters: out.parameters, planId: out.planId, trigger: 'saved_view_run' } }, cell.as(root));
      assert.equal(rerun.outcome, 'answer');
      assert.equal((await ledgerRows(out.planId)).length, 2);
    }
  });

  test('a clarification answered narrows the vocabulary to the chosen type; the focus is offered first', async () => {
    modelReplies.push(invoicePlan());
    const out = await gateway.call(compileQuestion, {
      body: {
        question: 'Show me the open ones', focus: { objectTypeId: type('invoice').id },
        chosen: { about: 'object_type', elementId: type('invoice').id, rejectedIds: [type('supplier').id] },
      },
    }, keyed(root));
    assert.equal(out.outcome, 'answer', JSON.stringify(out).slice(0, 300));
    const prompt = JSON.stringify(modelRequests.at(-1)!.body);
    assert.ok(prompt.includes('Asked from'), 'the focus is named');
    assert.ok(!prompt.includes('"supplier"'), 'the candidate passed over is not offered again');
  });

  test('an AI agent (D236): its brief reaches the model as documentation, only its types are offered, and it never widens what the reader sees', async () => {
    const agent = { id: uuidv7(), name: 'Receivables helper', brief: 'Open means sent and not yet paid.', objectTypeIds: [type('invoice').id], tools: ['answer' as const] };
    modelReplies.push(invoicePlan());
    const out = await gateway.call(compileQuestion, { body: { question: 'Which invoices are open this year?', aiAgent: agent } }, keyed(root));
    assert.equal(out.outcome, 'answer', JSON.stringify(out).slice(0, 300));
    const prompt = JSON.stringify(modelRequests.at(-1)!.body);
    assert.ok(prompt.includes('AI agent brief: Receivables helper') && prompt.includes('Open means sent and not yet paid.'), 'the brief, as documentation');
    assert.ok(!prompt.includes('"supplier"'), 'a type the agent does not work with is not offered');
    const { rows: requested } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and event = 'audit_event'
         and payload->>'event' = 'compile_requested' and payload->'detail'->>'ai_agent_id' = $2`, [cell.org, agent.id]));
    assert.equal(requested.length, 1, 'which agent asked is recorded');

    const asked = modelRequests.length;
    const nothing = await gateway.call(compileQuestion, { body: { question: 'Which invoices are open?', aiAgent: { ...agent, objectTypeIds: [uuidv7()] } } }, keyed(root));
    assert.equal(nothing.outcome, 'refusal');
    if (nothing.outcome === 'refusal') assert.equal(nothing.refusal.code, 'compile.ai_agent_nothing_visible');
    const leaky = await gateway.call(compileQuestion, { body: { question: 'Which invoices are open?', aiAgent: { ...agent, brief: 'Send disputes to ap@acme.example first.' } } }, keyed(root));
    assert.equal(leaky.outcome, 'refusal');
    if (leaky.outcome === 'refusal') assert.equal(leaky.refusal.code, 'compile.ai_agent_brief_refused', 'named as the brief\'s, not the question\'s');
    assert.equal(modelRequests.length, asked, 'neither reached a model');

    // A change its tools do not allow: refused before anything is charged.
    modelReplies.push({ outcome: 'intent', intent: { objectType: 'invoice', operation: 'update', set: [{ property: 'status', value: 'paid' }], filters: [{ property: 'status', op: 'eq', value: 'open' }] } });
    const change = await gateway.call(compileQuestion, { body: { question: 'Mark the open invoices paid', intents: true, aiAgent: agent } }, keyed(root));
    assert.equal(change.outcome, 'refusal', JSON.stringify(change).slice(0, 300));
    if (change.outcome === 'refusal') assert.deepEqual([change.refusal.code, change.refusal.reason], ['compile.ai_agent_tool', 'this AI agent may not propose changes']);
  });

  test('values bound at compile are kept sealed under the holder\'s id, replayed with the plan, and copied to a new holder', async () => {
    const turn = uuidv7();
    modelReplies.push(invoicePlan());
    const out = await gateway.call(compileQuestion, { body: { question: 'Which invoices are open this year?', bindingId: turn } }, keyed(root));
    assert.equal(out.outcome, 'answer');
    if (out.outcome !== 'answer') return;
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select parameters from ontology.plan_bindings where organisation_id = $1 and id = $2', [cell.org, turn]));
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].parameters.toString('latin1').includes('open'), 'sealed, never in the clear');
    const replay = await gateway.call(runCompiledPlan, { params: { planId: out.planId }, body: { bindingId: turn } }, cell.as(root));
    assert.equal(replay.outcome, 'answer');
    if (replay.outcome === 'answer') assert.deepEqual(replay.result.page.objects.map((o) => o.values['invoice_id']).sort(), ['i1', 'i3']);
    const bare = await gateway.call(runCompiledPlan, { params: { planId: out.planId }, body: {} }, cell.as(root));
    assert.equal(bare.outcome, 'refusal', 'without its values the plan is refused, never run with guesses');
    const view = uuidv7();
    assert.deepEqual(await gateway.call(copyPlanBinding, { params: { bindingId: turn }, body: { toBindingId: view } }, cell.as(root)), { bindingId: view, planId: out.planId });
    const viewRun = await gateway.call(runCompiledPlan, { params: { planId: out.planId }, body: { bindingId: view } }, cell.as(root));
    assert.equal(viewRun.outcome, 'answer');
  });

  test('a set over an interface runs one sub-plan per implementing type, its values named by the shared properties (spec 21.9)', async () => {
    const iface = manifest.interfaces.find((i) => i.apiName === 'labelled')!;
    const set = await gateway.call(saveObjectSet, {
      body: { name: 'Everything labelled', definition: { kind: 'filter', base: { interfaceId: iface.id }, predicate: { cel: 'true', properties: [] } } },
    }, keyed(root));
    const out = await cell.client('workspace').call(runObjectSet, { body: { objectSetId: set.id } }, cell.as(root));
    assert.equal(out.outcome, 'answer', JSON.stringify(out).slice(0, 300));
    if (out.outcome !== 'answer') return;
    assert.deepEqual(Object.fromEntries((out.result.contributingTypes ?? []).map((c) => [c.objectTypeId, c.objects])),
      { [type('vendor').id]: 4, [type('region').id]: 3 });
    assert.deepEqual(out.result.page.objects.map((o) => o.values['label']).sort(), ['Acme Ltd', 'Brill Limited', 'Delta', 'East', 'North', 'South', 'Zulu']);
    assert.deepEqual(out.result.columns.map((c) => c.apiName), ['label']);
    // Explorer runs a saved set through the gateway (runOntologyObjectSet, U6): the same answer, as the reader.
    const viaGateway = await gateway.call(runObjectSet, { body: { objectSetId: set.id, select: [], trigger: 'structured' } }, cell.as(root));
    assert.equal(viaGateway.outcome, 'answer');
    if (viaGateway.outcome === 'answer') assert.equal(viaGateway.result.page.objects.length, 7);
  });

  test('a plan over an interface: one sub-plan per implementing type, ordered across them, grouped and counted; a distinct count across types is refused (spec 21.9)', async () => {
    const iface = manifest.interfaces.find((i) => i.apiName === 'labelled')!;
    const label = manifest.sharedProperties.find((s) => s.apiName === 'label')!.id;
    const base = { schemaVersion: '1' as const, ontologyVersionId: manifest.version.id, nodes: [{ interfaceId: iface.id }] };
    const listed = answer(await run(root, { ...base, select: [{ node: 0, property: label }], sort: [{ property: label, direction: 'desc' }], limit: 5 }));
    assert.deepEqual(values(listed, 'label'), ['Zulu', 'South', 'North', 'East', 'Delta'], 'ordered across the types, then cut');
    assert.deepEqual(listed.columns.map((c) => c.apiName), ['label']);
    assert.deepEqual(Object.fromEntries((listed.contributingTypes ?? []).map((c) => [c.objectTypeId, c.objects])), { [type('vendor').id]: 4, [type('region').id]: 3 });
    assert.equal(listed.population, 7);
    assert.equal(new Set(listed.page.objects.map((o) => o.objectTypeId)).size, 2, 'each object keeps its own type');

    const counted = answer(await run(root, { ...base, aggregate: { measures: [{ fn: 'count', node: 0, as: 'n' }] } }));
    assert.deepEqual(counted.page.groups.map((g) => g.measures['n']), [7], 'counts add across types');
    const filtered = answer(await run(root, { ...base, nodes: [{ interfaceId: iface.id, filters: [{ property: label, op: 'eq', value: { param: 'p1' } }] }], select: [{ node: 0, property: label }] }, { p1: 'East' }));
    assert.deepEqual(values(filtered, 'label'), ['East'], 'the filter names the shared property; each type filters its own');
    const distinct = await run(root, { ...base, aggregate: { measures: [{ fn: 'count_distinct', node: 0, property: label, as: 'labels' }] } });
    assert.equal((distinct as { refusal?: { code: string } }).refusal?.code, 'plan.measure_across_types');
    const notShared = await run(root, { ...base, select: [{ node: 0, property: prop('vendor', 'rating') }] });
    assert.equal((notShared as { refusal?: { code: string } }).refusal?.code, 'plan.property_unavailable', 'only the interface\'s shared properties');

    // Asked in words: the model may stand the plan on the interface.
    modelReplies.push({ outcome: 'plan', plan: { nodes: [{ objectType: 'labelled' }], aggregate: { measures: [{ fn: 'count', node: 0, as: 'n' }] } } });
    const asked = await gateway.call(compileQuestion, { body: { question: 'How many things have a label?' } }, keyed(root));
    assert.equal(asked.outcome, 'answer', JSON.stringify(asked).slice(0, 400));
    if (asked.outcome === 'answer') assert.deepEqual(asked.result.page.groups.map((g) => g.measures['n']), [7]);
  });

  test('a traversal set walks its path; set operations combine sets of one type by object id (spec 24.4)', async () => {
    const save = (name: string, definition: object) => gateway.call(saveObjectSet, { body: { name, definition: definition as never } }, keyed(root));
    const runSet = async (id: string) => {
      const out = await cell.client('workspace').call(runObjectSet, { body: { objectSetId: id, select: [] } }, cell.as(root));
      assert.equal(out.outcome, 'answer', JSON.stringify(out).slice(0, 300));
      return out.outcome === 'answer' ? out.result : undefined;
    };
    const rating = prop('vendor', 'rating');
    const high = await save('High rated', { kind: 'filter', base: { objectTypeId: type('vendor').id }, predicate: { cel: 'object.rating >= 4', properties: [rating] } });
    const low = await save('Low rated', { kind: 'filter', base: { objectTypeId: type('vendor').id }, predicate: { cel: 'object.rating <= 3', properties: [rating] } });
    const served = await save('Regions high rated vendors serve', {
      kind: 'traversal', start: { objectSetId: high.id }, path: [{ linkTypeId: link('vendor_regions').id, direction: 'forward' }],
    });
    const regions = (await runSet(served.id))!;
    assert.deepEqual(regions.page.objects.map((o) => o.values['region_name']).sort(), ['East', 'North', 'South']);
    const ids = async (id: string) => (await runSet(id))!.page.objects.map((o) => o.id).sort();
    const [highIds, lowIds] = [await ids(high.id), await ids(low.id)];
    const union = await save('All', { kind: 'composite', operation: 'union', operands: [high.id, low.id] });
    const both = await save('Both', { kind: 'composite', operation: 'intersection', operands: [high.id, low.id] });
    const onlyHigh = await save('High only', { kind: 'composite', operation: 'difference', operands: [high.id, low.id] });
    assert.deepEqual(await ids(union.id), [...highIds, ...lowIds].sort());
    assert.deepEqual(await ids(both.id), []);
    assert.deepEqual(await ids(onlyHigh.id), highIds);
  });

  test('a saved filter set runs on decided values; an explicit set keeps its listed objects', async () => {
    const set = await gateway.call(saveObjectSet, {
      body: {
        name: 'Big open invoices',
        definition: { kind: 'filter', base: { objectTypeId: type('invoice').id },
          predicate: { cel: 'object.status == "open" && object.total > 100.0', properties: [prop('invoice', 'status'), prop('invoice', 'total')] } },
      },
    }, keyed(root));
    const workspace = cell.client('workspace');
    const out = await workspace.call(runObjectSet, { body: { objectSetId: set.id, select: [prop('invoice', 'invoice_id')] } }, cell.as(root));
    assert.equal(out.outcome, 'answer', JSON.stringify(out).slice(0, 300));
    if (out.outcome !== 'answer') return;
    const ids = out.result.page.objects.map((o) => o.values['invoice_id']);
    assert.ok(ids.length > 0 && out.result.page.objects.every((o) => o.values['status'] === 'open' && Number(o.values['total']) > 100), 'only members');
    const explicit = await gateway.call(saveObjectSet, {
      body: { name: 'Two', definition: { kind: 'explicit', objectTypeId: type('invoice').id, ids: [out.result.page.objects[0]!.id] } },
    }, keyed(root));
    const two = await workspace.call(runObjectSet, { body: { objectSetId: explicit.id } }, cell.as(root));
    assert.equal(two.outcome, 'answer');
    if (two.outcome === 'answer') assert.deepEqual(two.result.page.objects.map((o) => o.id), [out.result.page.objects[0]!.id]);
  });
});

describe('a property computed over linked objects (spec 21.11)', () => {
  test('read through a hidden hop along the link it declares: its linked inputs only, filtered and sorted on like any property, never shown as a link', async () => {
    const branch = await gateway.call(openBranch, { body: { name: 'counts' } }, keyed(editor));
    const fn = await gateway.call(putFunction, {
      params: { branchId: branch.id, apiName: 'open_invoice_count' },
      body: {
        kind: 'computed_property', description: 'How many of its invoices are open', expression: 'size(links.supplier_invoices.filter(i, i.status == "open"))',
        inputs: { objectTypes: ['supplier', 'invoice'], properties: [{ objectType: 'invoice', property: 'status' }], linkTypes: ['supplier_invoices'] },
        outputType: { dataType: 'integer' },
      } as never,
    }, keyed(editor));
    const m = (connectionId: string, sourceObject: string, fieldPath: string) => ({ connectionId, sourceObject, fieldPath });
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'supplier' }, body: {
      displayName: 'Supplier', pluralName: 'Suppliers',
      contributingObjects: [{ connectionId: crm, sourceObject: 'suppliers', identifierFieldPath: 'id' }, { connectionId: ledger, sourceObject: 'vendors', identifierFieldPath: 'code' }],
      properties: [
        { apiName: 'name', displayName: 'Name', dataType: 'string', mappings: [m(crm, 'suppliers', 'name'), m(ledger, 'vendors', 'vendor_name')] },
        { apiName: 'region', displayName: 'Region', dataType: 'string', mappings: [m(crm, 'suppliers', 'region')] },
        { apiName: 'registration', displayName: 'Registration', dataType: 'string', mappings: [m(crm, 'suppliers', 'reg_no'), m(ledger, 'vendors', 'registration')] },
        { apiName: 'rating', displayName: 'Rating', dataType: 'integer', mappings: [m(ledger, 'vendors', 'rating')] },
        { apiName: 'open_invoice_count', displayName: 'Open invoices', dataType: 'integer', computedFunctionVersionId: fn.element.version.id },
      ],
      title: 'name', matchKeys: [{ property: 'registration', normalisation: 'value.trim()' }],
    } as never }, keyed(editor));
    const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Counts' } }, keyed(editor));
    await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
    await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
    const next = await gateway.call(getManifest, { query: {} }, cell.as(root));
    const supplier = next.objectTypes.find((t) => t.apiName === 'supplier')!;
    const id = (name: string) => supplier.properties.find((p) => p.apiName === name)!.identityId;
    const ask = (body: Omit<QueryPlanInput, 'schemaVersion' | 'ontologyVersionId'>, parameters: Record<string, unknown> = {}) =>
      run(root, { schemaVersion: '1', ontologyVersionId: next.version.id, ...body }, parameters);

    const counted = answer(await ask({
      nodes: [{ objectTypeId: supplier.id }], select: [{ node: 0, property: id('registration') }, { node: 0, property: id('open_invoice_count') }],
      sort: [{ property: id('open_invoice_count'), direction: 'desc' }],
    }));
    // Each supplier by its registration, or that registration's state where none is shown (R4's two systems disagree).
    const counts = counted.page.objects.map((o) => [o.values['registration'] ?? o.states['registration'], o.values['open_invoice_count']]);
    assert.deepEqual([...counts].sort(), [['R1', 1], ['R2', 1], ['R3', 1], ['R9', 0], ['disputed', 0], ['empty', 0]], 'counted from each supplier\'s invoices');
    assert.deepEqual(counts.map(([, n]) => n), [1, 1, 1, 0, 0, 0], 'sorted on like any property');
    assert.ok(counted.page.objects.every((o) => Object.keys(o.links).length === 0), 'the hidden hop is never shown');
    assert.deepEqual(counted.columns.map((c) => c.apiName), ['registration', 'open_invoice_count']);

    const filtered = answer(await ask({
      nodes: [{ objectTypeId: supplier.id, filters: [{ property: id('open_invoice_count'), op: 'gte', value: { param: 'p1' } }] }],
      select: [{ node: 0, property: id('registration') }],
    }, { p1: 1 }));
    assert.deepEqual(filtered.page.objects.map((o) => o.values['registration']).sort(), ['R1', 'R2', 'R3'], 'filtered once the linked objects are read');

    // The object view computes it for its one object too.
    const opened = await cell.client('workspace').call(readObjectView, { body: { objectTypeId: supplier.id, object: { connectionId: crm, reference: 's3' } } }, cell.as(root));
    assert.equal(opened.outcome, 'object', JSON.stringify(opened).slice(0, 300));
    if (opened.outcome === 'object') {
      const count = opened.view.properties.find((p) => p.apiName === 'open_invoice_count')!;
      assert.deepEqual([count.computed, count.value, count.state], [true, 1, 'only']);
    }
  });
});

describe('partial aggregate pushdown for a resolvable type declared disjoint (spec 27.7)', () => {
  test('each system computes its share and the shares are added; refused where the declaration is contradicted by the entity graph', async () => {
    const branch = await gateway.call(openBranch, { body: { name: 'places' } }, keyed(editor));
    const m = (sourceObject: string, fieldPath: string) => ({ connectionId: ledger, sourceObject, fieldPath });
    const place = (disjointSources: boolean, contributing: 'both' | 'vendors') => ({
      displayName: 'Place', pluralName: 'Places',
      contributingObjects: [
        { connectionId: ledger, sourceObject: 'vendors', identifierFieldPath: 'code' },
        ...(contributing === 'both' ? [{ connectionId: ledger, sourceObject: 'regions', identifierFieldPath: 'code' }] : []),
      ],
      properties: [
        { apiName: 'place_code', displayName: 'Code', dataType: 'string', mappings: [m('vendors', 'code'), ...(contributing === 'both' ? [m('regions', 'code')] : [])] },
        { apiName: 'place_name', displayName: 'Name', dataType: 'string', mappings: [m('vendors', 'vendor_name'), ...(contributing === 'both' ? [m('regions', 'region_name')] : [])] },
      ],
      title: 'place_name', disjointSources,
      ...(contributing === 'both' ? { matchKeys: [{ property: 'place_code' }] } : { primaryKey: 'place_code' }),
    });
    await assert.rejects(gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'place' }, body: place(true, 'vendors') as never }, keyed(editor)),
      { code: 'ontology.disjoint_sources_invalid' }, 'one system has nothing to split');
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'place' }, body: place(true, 'both') as never }, keyed(editor));
    const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Places' } }, keyed(editor));
    await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
    await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
    const next = await gateway.call(getManifest, { query: {} }, cell.as(root));
    const placeType = next.objectTypes.find((t) => t.apiName === 'place')!;
    assert.equal(placeType.disjointSources, true);
    const code = placeType.properties.find((p) => p.apiName === 'place_code')!.identityId;
    const ask = (body: Omit<QueryPlanInput, 'schemaVersion' | 'ontologyVersionId'>, parameters: Record<string, unknown> = {}) =>
      run(root, { schemaVersion: '1', ontologyVersionId: next.version.id, ...body }, parameters);
    const count = { nodes: [{ objectTypeId: placeType.id }], aggregate: { measures: [{ fn: 'count' as const, node: 0, as: 'n' }] } };

    const pushed = answer(await ask(count));
    assert.deepEqual([pushed.aggregateForm, pushed.page.groups.map((g) => g.measures['n'])], ['partial_pushdown', [7]], 'four vendors and three regions, counted in their systems');
    const filtered = answer(await ask({
      nodes: [{ objectTypeId: placeType.id, filters: [{ property: code, op: 'in', value: { param: 'p1' } }] }], aggregate: count.aggregate,
    }, { p1: ['V1', 'N', 'V9'] }));
    assert.deepEqual([filtered.aggregateForm, filtered.page.groups.map((g) => g.measures['n'])], ['partial_pushdown', [3]], 'the filter runs in each system too');

    // Every object read once, so the entity graph knows them; then one bound to records in both systems contradicts the declaration.
    answer(await ask({ nodes: [{ objectTypeId: placeType.id }], select: [{ node: 0, property: code }] }));
    await cell.migrate.query(
      `insert into ontology.match_keys (id, organisation_id, object_type_id, silo_object_id, connection_id, source_object, source_identifier_hash, match_key_hash,
         hmac_key_version_id, origin)
       select gen_random_uuid(), organisation_id, object_type_id, silo_object_id, connection_id, 'regions', source_identifier_hash, match_key_hash, hmac_key_version_id, origin
         from ontology.match_keys where object_type_id = $1 and source_object = 'vendors' and superseded_at is null limit 1`, [placeType.id]);
    // (A different question from the first, so no kept answer stands in for it.)
    const merged = answer(await ask({ ...count, aggregate: { measures: [{ fn: 'count' as const, node: 0, as: 'places' }] } }));
    assert.deepEqual([merged.aggregateForm, merged.page.groups.map((g) => g.measures['places'])], ['merged', [7]], 'computed over merged objects instead, and says so');
  });
});

describe('compiling against an ontology branch (spec 25.3)', () => {
  test('for holders of ontology.branch: the answer and its explanation say it was computed on the branch, lineage records it; main is untouched', async () => {
    const branch = await gateway.call(openBranch, { body: { name: 'memos' } }, keyed(editor));
    await gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'memo' }, body: {
      displayName: 'Memo', pluralName: 'Memos', contributingObjects: [{ connectionId: crm, sourceObject: 'notes', identifierFieldPath: 'id' }],
      properties: [
        { apiName: 'memo_id', displayName: 'Id', dataType: 'string', mappings: [{ connectionId: crm, sourceObject: 'notes', fieldPath: 'id' }] },
        { apiName: 'memo_body', displayName: 'Body', dataType: 'string', mappings: [{ connectionId: crm, sourceObject: 'notes', fieldPath: 'body' }] },
      ],
      primaryKey: 'memo_id', title: 'memo_id',
    } as never }, keyed(editor));
    const onBranch = await gateway.call(getManifest, { query: { branchId: branch.id } }, cell.as(root));
    const memo = onBranch.objectTypes.find((t) => t.apiName === 'memo')!;
    assert.equal((await gateway.call(getManifest, { query: {} }, cell.as(root))).objectTypes.some((t) => t.apiName === 'memo'), false, 'a branch never changes main');
    const memoPlan: QueryPlanInput = {
      schemaVersion: '1', ontologyVersionId: onBranch.version.id, nodes: [{ objectTypeId: memo.id }],
      aggregate: { measures: [{ fn: 'count', node: 0, as: 'n' }] },
    };
    const counted = answer(await run(root, memoPlan));
    assert.deepEqual(counted.page.groups.map((g) => g.measures['n']), [40]);
    assert.deepEqual(counted.branch, { branchId: branch.id, kind: 'working' }, 'computed on the branch, and says so');
    assert.ok(counted.lineage.every((l) => l.branchId === branch.id), 'lineage records the branch');
    const explained = await gateway.call(compilePlan, { body: { plan: memoPlan, execute: false } }, cell.as(root));
    assert.equal(explained.outcome, 'plan');
    if (explained.outcome === 'plan') assert.deepEqual(explained.explanation.branch, { branchId: branch.id, kind: 'working' });
    // A member without ontology.branch never compiles against a branch, even holding its version's id.
    await assert.rejects(run(viewer, memoPlan), (e: { category?: string }) => e.category === 'forbidden');

    // A question compiled against the branch's head.
    modelReplies.push({ outcome: 'plan', plan: { nodes: [{ objectType: 'memo' }], aggregate: { measures: [{ fn: 'count', node: 0, as: 'n' }] } } });
    const asked = await gateway.call(compileQuestion, { body: { question: 'How many memos are there?', branchId: branch.id } }, keyed(root));
    assert.equal(asked.outcome, 'answer', JSON.stringify(asked).slice(0, 400));
    if (asked.outcome === 'answer') assert.deepEqual([asked.result.branch?.branchId, asked.result.page.groups[0]!.measures['n']], [branch.id, 40]);
  });
});

describe('markings on functions and interfaces (spec 21.15)', () => {
  test('a computed property whose function carries a marking the reader does not hold is absent; held, it is there', async () => {
    const vat = manifest.functions.find((f) => f.apiName === 'total_with_vat')!;
    const tax = (await gateway.call(createMarking, { body: { name: 'Tax workings', kind: 'compartment' } }, cell.as(root))).id;
    await gateway.call(applyMarking, { body: { markingId: tax, resource: { type: 'function', id: vat.id } } }, cell.as(root));
    const asked = () => run(root, plan({
      nodes: [{ objectTypeId: type('invoice').id }], select: [{ node: 0, property: prop('invoice', 'invoice_id') }, { node: 0, property: prop('invoice', 'total_with_vat') }],
    }));
    const withheld = await asked();
    assert.equal(withheld.outcome, 'refusal');
    assert.equal((withheld as { refusal: { code: string } }).refusal.code, 'plan.property_unavailable', 'never named, so never computed');
    const plain = answer(await run(root, plan({ nodes: [{ objectTypeId: type('invoice').id }], select: [{ node: 0, property: prop('invoice', 'total') }] })));
    assert.ok(plain.page.objects.length > 0, 'its inputs are still the reader\'s');
    await gateway.call(grantClearance, { body: { markingId: tax, holder: { kind: 'membership', id: root.membershipId } } }, cell.as(root));
    assert.ok(answer(await asked()).page.objects.every((o) => typeof o.values['total_with_vat'] === 'number'));
  });

  test('a set over an interface that carries a marking the reader does not hold is refused whole; held, it runs', async () => {
    const iface = manifest.interfaces.find((i) => i.apiName === 'labelled')!;
    const labels = (await gateway.call(createMarking, { body: { name: 'Labels', kind: 'compartment' } }, cell.as(root))).id;
    await gateway.call(applyMarking, { body: { markingId: labels, resource: { type: 'interface', id: iface.id } } }, cell.as(root));
    const set = await gateway.call(saveObjectSet, {
      body: { name: 'Labelled, marked', definition: { kind: 'filter', base: { interfaceId: iface.id }, predicate: { cel: 'true', properties: [] } } },
    }, keyed(root));
    const workspace = cell.client('workspace');
    const refused = await workspace.call(runObjectSet, { body: { objectSetId: set.id } }, cell.as(root));
    assert.equal(refused.outcome === 'refusal' && refused.refusal.code, 'query.interface_unavailable');
    await gateway.call(grantClearance, { body: { markingId: labels, holder: { kind: 'membership', id: root.membershipId } } }, cell.as(root));
    const out = await workspace.call(runObjectSet, { body: { objectSetId: set.id } }, cell.as(root));
    assert.equal(out.outcome, 'answer', JSON.stringify(out).slice(0, 300));
  });
});

describe('as of a moment, and history over a period, in a question (69.6, 69.16)', () => {
  const ask = (question: string) => gateway.call(compileQuestion, { body: { question } }, keyed(root));
  const invoices = { objectType: 'invoice' };

  test('"as of 1 March" compiles to an as-of plan: the date a parameter, the end of that day; no Warehouse here, so refused by name', async () => {
    modelReplies.push({ outcome: 'plan', plan: { nodes: [invoices], select: [{ node: 0, property: 'status' }], asOf: { at: '2026-03-01', asWritten: 'as of 1 March' } } });
    const out = await ask('What was each invoice\'s status as of 1 March?');
    assert.equal(out.outcome, 'refusal', JSON.stringify(out).slice(0, 400));
    if (out.outcome !== 'refusal') return;
    assert.equal(out.refusal.code, 'plan.as_of_unavailable', 'a date is accepted as the moment; the past is the Warehouse\'s');
    const prompt = JSON.stringify(modelRequests.at(-1)!.body);
    assert.ok(prompt.includes('as of 1 March') && prompt.includes('set asOf'), 'the instructions name asOf');
  });

  test('"how did ... change this quarter" compiles to a history plan; combined with an aggregate it is refused, not repaired', async () => {
    modelReplies.push({ outcome: 'plan', plan: {
      nodes: [invoices], select: [{ node: 0, property: 'status' }],
      history: { expression: { kind: 'calendar', unit: 'quarter', offset: 0 }, asWritten: 'this quarter' },
    } });
    const out = await ask('How did invoice statuses change this quarter?');
    assert.deepEqual(out.outcome === 'refusal' && out.refusal.code, 'plan.as_of_unavailable', JSON.stringify(out).slice(0, 400));
    modelReplies.push({ outcome: 'plan', plan: {
      nodes: [invoices], aggregate: { measures: [{ fn: 'count', node: 0, as: 'n' }] },
      history: { expression: { kind: 'trailing', unit: 'month', count: 1 }, asWritten: 'the past month' },
    } });
    const both = await ask('How many invoices changed over the past month?');
    assert.deepEqual(both.outcome === 'refusal' && both.refusal.code, 'compile.plan_invalid');
  });
});

describe('narrowing a large vocabulary (decision 2026-11-15)', () => {
  const invoices = {
    outcome: 'plan',
    plan: { nodes: [{ objectType: 'invoice', filters: [{ property: 'status', op: 'eq', value: 'open' }] }], select: [{ node: 0, property: 'invoice_id' }], sort: [] },
  };
  const regions = { outcome: 'plan', plan: { nodes: [{ objectType: 'region', filters: [] }], select: [{ node: 0, property: 'region_name' }], sort: [] } };
  // A client made after the narrowing compile started, so it is the one asked.
  const ask = (question: string) => cell.client('gateway').call(compileQuestion, { body: { question } }, keyed(root));
  type Narrowed = { outcome: string; narrowing?: { objectTypeIds: string[]; widened: boolean } };

  before(async () => {
    // A compile bound of two types: four are visible, so every question is narrowed.
    await cell.start(compileService, 'compile', 'test_app', { EXECUTOR_MAX_ROWS_PER_SOURCE_STEP: String(SOURCE_ROWS), EXECUTOR_MAX_RESULT_ROWS: String(RESULT_ROWS), COMPILE_NARROW_TYPES: '2' });
  });

  test('the question is compiled against the types it is about, with their properties; the descriptions are embedded once', async () => {
    modelReplies.push(invoices);
    const before = modelRequests.length;
    const out = await ask('Which invoices are open?') as Narrowed;
    assert.equal(out.outcome, 'answer', JSON.stringify(out).slice(0, 400));
    assert.ok(out.narrowing && !out.narrowing.widened);
    assert.ok(out.narrowing.objectTypeIds.includes(type('invoice').id), 'named, and most like the question');
    assert.ok(out.narrowing.objectTypeIds.length < 4);
    assert.equal(modelRequests.length, before + 1);
    const prompt = JSON.stringify(modelRequests.at(-1)!.body);
    const left = [type('supplier'), type('vendor'), type('region')].filter((t) => !out.narrowing!.objectTypeIds.includes(t.id));
    assert.ok(left.length > 0);
    for (const t of left) assert.ok(!prompt.includes(`"${t.apiName}"`), `${t.apiName} is not offered`);
    // Every type, property and link on main embedded, metadata only; then only the question.
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select kind, count(*)::int as n from ontology.description_embeddings group by kind order by kind', []));
    assert.deepEqual(rows.map((r: { kind: string }) => r.kind), ['link_type', 'object_type', 'property']);
    assert.ok(!embedded.flat().some((t) => /Acme|Brill|i3|R1/.test(t)), 'names and descriptions, never a record value');
    const sent = embedded.length;
    modelReplies.push(invoices);
    await ask('Which invoices are open?');
    assert.deepEqual(embedded.slice(sent).map((texts) => texts.length), [1], 'nothing changed: only the question is embedded');
  });

  test('a type the question names is always offered', async () => {
    modelReplies.push(regions);
    const out = await ask('List the regions') as Narrowed;
    assert.equal(out.outcome, 'answer', JSON.stringify(out).slice(0, 400));
    assert.ok(out.narrowing!.objectTypeIds.includes(type('region').id));
  });

  test('where the narrowed vocabulary cannot answer, compile widens to all of it once, and says so', async () => {
    modelReplies.push(regions, regions);
    const before = modelRequests.length;
    const out = await ask('Which invoices are open?') as Narrowed;
    assert.equal(out.outcome, 'answer', JSON.stringify(out).slice(0, 400));
    assert.equal(out.narrowing?.widened, true);
    assert.equal(modelRequests.length, before + 2, 'narrowed, then whole: twice, never more');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload -> 'detail' as detail from platform.outbox where payload ->> 'event' = 'plan_validated' order by created_at desc limit 1`, []));
    assert.equal(rows[0].detail.narrowed, true);
    assert.equal(rows[0].detail.widened, true);
  });
});

describe('the organisation calendar (26.6)', () => {
  test('any member reads it; calendar.manage changes it, naming the version it read; calendar_changed records what changed', async () => {
    const before = await gateway.call(getOrganisationCalendar, {}, cell.as(viewer));
    const next = { timeZone: 'Australia/Sydney', financialYearStartMonth: 7, financialYearStartDay: 1, weekStartDay: 1, financialYearLabel: 'end_year' as const };
    await assert.rejects(gateway.call(setOrganisationCalendar, { body: { ...next, version: before.version } }, cell.as(viewer)), { code: 'compile.not_permitted' });
    await assert.rejects(gateway.call(setOrganisationCalendar, { body: { ...next, financialYearLabel: null, version: before.version } }, cell.as(root)),
      { code: 'calendar.financial_year_incomplete' });
    await assert.rejects(gateway.call(setOrganisationCalendar, { body: { ...next, timeZone: 'Mars/Olympus', version: before.version } }, cell.as(root)),
      { code: 'calendar.invalid' }, 'an IANA time zone only');
    const after = await gateway.call(setOrganisationCalendar, { body: { ...next, version: before.version } }, cell.as(root));
    assert.deepEqual([after.timeZone, after.financialYearStartMonth, after.updatedBy, after.version], ['Australia/Sydney', 7, root.membershipId, before.version + 1]);
    await assert.rejects(gateway.call(setOrganisationCalendar, { body: { ...next, weekStartDay: 7, version: before.version } }, cell.as(root)),
      { code: 'calendar.version_stale' });
    const { rows } = await cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'calendar_changed'`, [cell.org]);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].detail.time_zone, rows[0].detail.financial_year, rows[0].detail.week_start, rows[0].detail.from_time_zone, rows[0].detail.to_time_zone],
      [true, true, false, before.timeZone, 'Australia/Sydney']);
    // Back as it was, for anything after.
    await gateway.call(setOrganisationCalendar, { body: { timeZone: before.timeZone, financialYearStartMonth: before.financialYearStartMonth,
      financialYearStartDay: before.financialYearStartDay, weekStartDay: before.weekStartDay, financialYearLabel: before.financialYearLabel, version: after.version } }, cell.as(root));
  });
});

describe('a type the reader\'s markings leave out (spec 21.15, 57.11)', () => {
  test('is dropped before the model is asked, and recorded by reference with how many markings are lacking, never the question', async () => {
    const note = type('note');
    const markings: string[] = [];
    for (const name of ['Field notes', 'Site diaries']) {
      const id = (await gateway.call(createMarking, { body: { name, kind: 'compartment' } }, cell.as(root))).id;
      await gateway.call(applyMarking, { body: { markingId: id, resource: { type: 'object_type', id: note.id } } }, cell.as(root));
      markings.push(id);
    }
    const dropped = async () => (await cell.migrate.query(
      `select payload->'resource' as resource, payload->'detail' as detail from platform.outbox
       where organisation_id = $1 and payload->>'event' = 'type_dropped_from_plan' and payload->'resource'->>'id' = $2 order by seq`,
      [cell.org, note.id])).rows as { resource: { type: string }; detail: Record<string, unknown> }[];
    const question = 'How many invoices mention the site diaries?';
    modelReplies.push({ outcome: 'plan', plan: { nodes: [{ objectType: 'invoice' }], aggregate: { measures: [{ fn: 'count', node: 0, as: 'n' }] } } });
    await gateway.call(compileQuestion, { body: { question } }, keyed(root));
    assert.ok(!JSON.stringify(modelRequests.at(-1)!.body).includes(`"${note.apiName}"`), 'never named to the model');
    const recorded = await dropped();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.resource.type, 'object_type');
    assert.equal(recorded[0]!.detail['unsatisfied_markings'], 2);
    assert.ok(!JSON.stringify(recorded[0]).includes('diaries'), 'never the question');

    for (const id of markings) await gateway.call(grantClearance, { body: { markingId: id, holder: { kind: 'membership', id: root.membershipId } } }, cell.as(root));
    modelReplies.push({ outcome: 'plan', plan: { nodes: [{ objectType: 'invoice' }], aggregate: { measures: [{ fn: 'count', node: 0, as: 'n' }] } } });
    await gateway.call(compileQuestion, { body: { question } }, keyed(root));
    assert.equal((await dropped()).length, 1, 'cleared: not dropped, so nothing more recorded');

    // A plan over the marked type: its prompt vocabulary carries the markings (62.4), recorded once, when first kept.
    const p = plan({ nodes: [{ objectTypeId: note.id }], aggregate: { measures: [{ fn: 'count', node: 0, as: 'n' }] } } as never);
    const first = await run(root, p) as { planId?: string };
    await run(root, p);
    const { rows } = await cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'prompt_vocabulary_marked' and payload->'resource'->>'id' = $2`,
      [cell.org, first.planId]);
    assert.deepEqual(rows.map((r) => r.detail.markings), [2]);
  });
});

describe('a change asked for: an intent (spec 42.9)', () => {
  const askChange = (question: string, bindingId = uuidv7()) =>
    gateway.call(compileQuestion, { body: { question, intents: true, bindingId } }, keyed(root));
  type Intent = { outcome: 'intent'; intent: { candidates: { actionTypeId: string; parameters: Record<string, unknown> }[]; genericEdit: boolean; targetsPlanId: string | null; set: Record<string, unknown>; operation: string } };

  test('bound to the confirmed Action type that makes it, its parameters filled; the records as a plan that finds them; never executed', async () => {
    // A confirmed type that sets an invoice's status from a parameter.
    const invoice = type('invoice');
    const [actionTypeId, versionId] = [uuidv7(), uuidv7()];
    const { rows: [rootScope] } = await cell.migrate.query('select id from iam.scopes where organisation_id = $1 and parent_scope_id is null', [cell.org]);
    await cell.migrate.query(`insert into action.action_types (id, organisation_id, api_name, display_name, owning_scope_id, proposed_by_membership_id)
      values ($1, $2, 'settle_invoice', 'Settle invoice', $3, $4)`, [actionTypeId, cell.org, rootScope.id, root.membershipId]);
    await cell.migrate.query(`insert into action.action_type_versions (id, organisation_id, action_type_id, version, ontology_version_id, targets, rules,
      permitted_connections, permitted_operations, risk_class, confirmed_by) values ($1, $2, $3, 1, $4, $5, $6, $7, '{}', 'data', $8)`, [
      versionId, cell.org, actionTypeId, manifest.version.id, JSON.stringify({ objectTypeId: invoice.id, properties: { status: prop('invoice', 'status') } }),
      JSON.stringify([{ kind: 'set_property', property: 'status', value: { parameter: 'new_status' } }]), [invoice.contributingObjects[0]!.connectionId], root.membershipId]);
    await cell.migrate.query(`insert into action.action_parameters (id, organisation_id, action_type_version_id, sequence, name, param_type, required)
      values ($1, $2, $3, 1, 'new_status', 'string', true)`, [uuidv7(), cell.org, versionId]);
    await cell.migrate.query(`update action.action_types set status = 'confirmed', current_version_id = $1 where id = $2`, [versionId, actionTypeId]);

    modelReplies.push({ outcome: 'intent', intent: { objectType: 'invoice', operation: 'update', set: [{ property: 'status', value: 'paid' }], filters: [{ property: 'status', op: 'eq', value: 'open' }] } });
    const bindingId = uuidv7();
    const runs = modelRequests.length;
    const out = await askChange('Mark the open invoices as paid', bindingId) as unknown as Intent;
    assert.equal(out.outcome, 'intent', JSON.stringify(out).slice(0, 400));
    assert.ok(JSON.stringify(modelRequests.at(-1)!.body).includes('outcome intent'), 'the model is told a change may be asked for');
    assert.equal(modelRequests.length, runs + 1);
    assert.deepEqual(out.intent.candidates.map((c) => [c.actionTypeId, c.parameters]), [[actionTypeId, { new_status: 'paid' }]]);
    assert.equal(out.intent.genericEdit, false);
    const found = await gateway.call(runCompiledPlan, { params: { planId: out.intent.targetsPlanId! }, body: { bindingId } }, cell.as(root));
    assert.equal(found.outcome, 'answer', JSON.stringify(found).slice(0, 300));
    const bound = await cell.migrate.query(
      `select payload->'resource'->>'id' as type, payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'action_intent_bound'`, [cell.org]);
    assert.deepEqual([bound.rows.at(-1).type, bound.rows.at(-1).detail.action_type_id, bound.rows.at(-1).detail.candidates], [invoice.id, actionTypeId, 1]);
    assert.ok(!JSON.stringify(bound.rows).includes('paid'), 'references and counts, never a value');
  });

  test('where no confirmed type fits, the generic governed edit; a name nobody offered is refused; plain questions are not told about changes', async () => {
    modelReplies.push({ outcome: 'intent', intent: { objectType: 'supplier', operation: 'update', set: [{ property: 'rating', value: 5 }], filters: [{ property: 'region', op: 'eq', value: 'north' }] } });
    const generic = await askChange('Rate the northern suppliers 5') as unknown as Intent;
    assert.equal(generic.outcome, 'intent', JSON.stringify(generic).slice(0, 400));
    assert.deepEqual([generic.intent.candidates, generic.intent.genericEdit, generic.intent.set], [[], true, { rating: 5 }]);

    modelReplies.push({ outcome: 'intent', intent: { objectType: 'supplier', operation: 'update', set: [{ property: 'secret_score', value: 1 }], filters: [{ property: 'region', op: 'eq', value: 'north' }] } });
    const unknown = await askChange('Set the secret score');
    assert.equal(unknown.outcome === 'refusal' && unknown.refusal.code, 'compile.unknown_property');

    modelReplies.push({ outcome: 'plan', plan: { nodes: [{ objectType: 'invoice' }], aggregate: { measures: [{ fn: 'count', node: 0, as: 'n' }] } } });
    await gateway.call(compileQuestion, { body: { question: 'How many invoices?' } }, keyed(root));
    assert.ok(!JSON.stringify(modelRequests.at(-1)!.body).includes('outcome intent'), 'a question compiled elsewhere is never an intent');
  });

  test('a Cron asked for: compile writes the schedule from the words, never the model; a count condition needs its number', async () => {
    const asWritten = 'every Monday and Wednesday at 8:30 if more than 10';
    modelReplies.push({ outcome: 'schedule', schedule: { every: 'week', at: '08:30', weekdays: ['wednesday', 'monday'], when: 'count_above', threshold: 10, then: 'notify', asWritten } });
    const out = await askChange('Every Monday and Wednesday at 8:30, tell me if more than 10 invoices are open');
    assert.equal(out.outcome, 'schedule', JSON.stringify(out).slice(0, 400));
    if (out.outcome === 'schedule') {
      assert.deepEqual(out.schedule, {
        schedule: '30 8 * * 1,3', condition: { kind: 'result', operator: 'count_crossed', threshold: 10, direction: 'above' }, action: 'notify', asWritten,
      });
    }
    modelReplies.push({ outcome: 'schedule', schedule: { every: 'day', when: 'count_above', asWritten: 'daily, if above' } });
    const refused = await askChange('Daily, if above');
    assert.equal(refused.outcome === 'refusal' && refused.refusal.code, 'compile.schedule_invalid');
  });
});

describe('starting a scenario from Ask (spec 36.4, 39.4)', () => {
  test('the failure the question states, compiled and saved as the asker\'s failure scenario on the object named; charged once as a compile', async () => {
    await cell.start(simulationService, 'simulation', 'test_app');
    await cell.start(createAskService(), 'ask', 'test_app');
    askRunning = true;
    const client = cell.client('gateway');
    const thread = await client.call(createThread, { body: {} }, keyed(root));
    const objectId = uuidv7();
    const start = (question: string) => client.call(askQuestion, {
      params: { threadId: thread.id }, body: { question, tool: 'start_scenario', subject: { kind: 'object', objectTypeId: type('invoice').id, objectId } },
    }, keyed(root));
    modelReplies.push({ outcome: 'failure', failure: { form: 'unavailable_for_period', period: { value: 2, unit: 'days' }, asWritten: 'held for two days' } });
    const out = await start('What if this invoice is held for two days?');
    assert.deepEqual([out.turn.outcome, out.turn.tool], ['answer', 'start_scenario'], JSON.stringify([out.turn.refusalReason, out.turn.narrowing]));
    const { rows } = await cell.migrate.query('select name, kind, owner_membership_id, stated_failure from simulation.scenarios where id = $1', [out.turn.scenarioId]);
    assert.deepEqual([rows[0].name, rows[0].kind, rows[0].owner_membership_id], ['held for two days', 'failure', root.membershipId]);
    assert.deepEqual([rows[0].stated_failure.form, rows[0].stated_failure.objectIds, rows[0].stated_failure.period], ['unavailable_for_period', [objectId], { value: 2, unit: 'days' }]);
    const { rows: started } = await cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'ask_scenario_started'`, [cell.org]);
    assert.deepEqual([started.at(-1).detail.scenario_id, started.at(-1).detail.form], [out.turn.scenarioId, 'unavailable_for_period']);

    modelReplies.push({ outcome: 'failure', failure: { form: 'delayed', asWritten: 'late' } });
    const invalid = await start('What if it is late?');
    assert.deepEqual([invalid.turn.outcome, invalid.turn.scenarioId], ['refusal', null], 'a delay states how long');
  });
});

describe('an Ask answer continued as an analysis (spec 37.8)', () => {
  test('its plan made steps, its values carried under the analysis and its period kept as the asker wrote it; another member may not continue it', async () => {
    if (!askRunning) {
      await cell.start(createAskService(), 'ask', 'test_app');
      askRunning = true;
    }
    await cell.start(createWorkspaceService(), 'workspace', 'test_app');
    const client = cell.client('gateway');
    const thread = await client.call(createThread, { body: {} }, keyed(root));
    modelReplies.push(invoicePlanReply());
    const asked = await client.call(askQuestion, { params: { threadId: thread.id }, body: { question: 'Open invoices this year' } }, keyed(root));
    assert.equal(asked.turn.outcome, 'answer', JSON.stringify([asked.turn.refusalReason, asked.turn.narrowing]));
    const made = await client.call(createAnalysisFromTurn, { body: { threadId: thread.id, sequence: asked.turn.sequence } }, cell.as(root));
    assert.equal(made.outcome, 'analysis', JSON.stringify(made).slice(0, 400));
    if (made.outcome !== 'analysis') return;
    const first = made.steps[0]!.step as { operation: string; filters: unknown[]; period?: { asWritten: string; expression: { kind: string } } };
    assert.deepEqual([made.steps.length, first.operation, first.filters.length, first.period?.asWritten, first.period?.expression.kind], [1, 'filter', 1, 'this year', 'between']);
    const values = await client.call(readAnalysis, { params: { manifestId: made.manifestId }, query: { analysisId: made.analysisId } }, cell.as(root));
    assert.ok(values.parameters !== null && Object.values(values.parameters).includes('open'), 'the answer\'s values, for its asker');
    const ran = await client.call(runWorkspaceAnalysis, { params: { manifestId: made.manifestId }, body: { analysisId: made.analysisId } }, cell.as(root));
    const step = ran.steps[0]!;
    assert.equal(step.outcome, 'result');
    assert.equal(step.outcome === 'result' && step.results[0]!.total, 2, 'i1 and i3: open, and issued this year');
    await assert.rejects(client.call(createAnalysisFromTurn, { body: { threadId: thread.id, sequence: asked.turn.sequence } }, cell.as(viewer)),
      { code: 'workspace.turn_not_found' }, 'never another member\'s answer, nor their values');
  });
});

describe('a harder question compiled as a chain of steps (spec 37.8, 26.10)', () => {
  /** North suppliers, their open invoices, the total by supplier, then the invoices behind s1: in names, with the question's values. */
  const chainReply = (property = 'region') => ({
    outcome: 'analysis',
    steps: [
      { operation: 'filter', objectType: 'supplier', filters: [{ property, op: 'eq', value: 'north' }] },
      { operation: 'traverse', input: 1, link: 'supplier_invoices', filters: [{ property: 'status', op: 'eq', value: 'open' }] },
      { operation: 'group', input: 2, groupBy: [{ property: 'supplier_ref' }], measures: [{ fn: 'sum', property: 'total', as: 'total' }] },
      { operation: 'select', input: 3, key: [{ property: 'supplier_ref', value: 's1' }] },
    ],
  });

  /** The model's replies for one question: a narrowed compile that cannot answer is widened and asks again. */
  const replies = (...r: unknown[]) => {
    modelReplies.length = 0;
    modelReplies.push(...r);
  };

  test('charged once as an advanced compile, run step by step, kept as the turn\'s answer; re-run free; continued in Analysis with its values', async () => {
    if (!askRunning) {
      await cell.start(createAskService(), 'ask', 'test_app');
      askRunning = true;
    }
    const client = cell.client('gateway');
    const thread = await client.call(createThread, { body: {} }, keyed(root));
    const ask = (advanced: boolean) => client.call(askQuestion, {
      params: { threadId: thread.id }, body: { question: 'North suppliers\' open invoices, total by supplier, and the invoices behind s1', advanced },
    }, keyed(root));

    // Not a harder question: a chain is not what compile asked for, so it is not taken (the model is asked again, then refused).
    replies(chainReply(), chainReply());
    const plain = await ask(false);
    assert.deepEqual([plain.turn.outcome, plain.turn.tokensCharged], ['refusal', 0]);

    replies(chainReply(), chainReply());
    const asked = await ask(true);
    assert.equal(asked.turn.outcome, 'answer', JSON.stringify([asked.turn.refusalReason, asked.turn.narrowing]));
    assert.deepEqual(asked.turn.chain, { operations: ['filter', 'traverse', 'group', 'select'] });
    assert.equal(asked.turn.tokensCharged, 3, 'an advanced compile, charged once when the chain exists');
    const answerRef = asked.turn.resultRef!;
    const last = await client.call(readResult, { params: { queryId: answerRef } }, cell.as(root));
    assert.equal(last.total, 1, 'the invoices behind s1 among the north suppliers\' open ones: i1');
    const { rows: steps } = await cell.migrate.query('select position, operation from workspace.analysis_steps where manifest_id = $1 order by position', [asked.turn.manifestId]);
    assert.deepEqual(steps.map((r) => r.operation), ['filter', 'traverse', 'group', 'select'], 'the steps recorded as any analysis\'s are');
    const { rows: kept } = await cell.migrate.query('select manifest::text as manifest from ontology.compiled_manifests where id = $1', [asked.turn.manifestId]);
    assert.ok(!kept[0].manifest.includes('north') && !kept[0].manifest.includes('s1'), 'the values are parameters, never in the chain');

    const again = await client.call(rerunTurn, { params: { threadId: thread.id, sequence: asked.turn.sequence } }, keyed(root));
    assert.deepEqual([again.refusalReason, again.resultRef !== null], [null, true], JSON.stringify(again));
    assert.equal((await client.call(readResult, { params: { queryId: again.resultRef! } }, cell.as(root))).total, 1);

    const continued = await client.call(createAnalysisFromTurn, { body: { threadId: thread.id, sequence: asked.turn.sequence } }, cell.as(root));
    assert.equal(continued.outcome, 'analysis', JSON.stringify(continued).slice(0, 300));
    if (continued.outcome !== 'analysis') return;
    assert.equal(continued.manifestId, asked.turn.manifestId, 'the same chain');
    const opened = await client.call(readAnalysis, { params: { manifestId: continued.manifestId }, query: { analysisId: continued.analysisId } }, cell.as(root));
    assert.deepEqual(Object.values(opened.parameters ?? {}).sort(), ['north', 'open', 's1'], 'its values, copied for the asker');
  });

  test('a chain naming what the asker cannot see is refused, free, as a plan would be', async () => {
    const client = cell.client('gateway');
    const thread = await client.call(createThread, { body: {} }, keyed(root));
    replies(chainReply('colour'), chainReply('colour'));
    const out = await client.call(askQuestion, { params: { threadId: thread.id }, body: { question: 'North suppliers by colour', advanced: true } }, keyed(root));
    assert.deepEqual([out.turn.outcome, out.turn.tokensCharged, out.turn.chain], ['refusal', 0, null]);
  });
});

/** The model's plan for open invoices this year, as the question describe has it. */
function invoicePlanReply() {
  return {
    outcome: 'plan',
    plan: {
      nodes: [{ objectType: 'invoice', filters: [{ property: 'status', op: 'eq', value: 'open' }],
        period: { asWritten: 'this year', expression: { kind: 'between', from: '2026-01-01', to: '2027-01-01' } } }],
      select: [{ node: 0, property: 'invoice_id' }], sort: [{ property: 'issued_on', direction: 'asc' }],
    },
  };
}

