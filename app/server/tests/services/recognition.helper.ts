// Shared by the recognition and simulation tests: a cell with the query path (ontology,
// connect-runtime, pushdown-compiler, planner, executor), model-gateway against a fake
// model, metering, notify, and recognition or simulation, over a fake REST API holding two
// systems (crm and erp) whose suppliers resolve by registration, plus orders, deliveries,
// notes and events in crm.

import type { SiloStoreChannel } from '../../src/services/connect-runtime/siloStore.service.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { grantAllowance } from '../../src/contracts/metering/allowance.contract.ts';
import { putLinkType, putObjectType } from '../../src/contracts/ontology/element.contract.ts';
import { getManifest, type OntologyManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { approveProposal, mergeProposal, openBranch, submitProposal } from '../../src/contracts/ontology/proposal.contract.ts';
import type { ServiceDefinition } from '../../src/infra/service.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as executorService } from '../../src/routes/executor/index.route.ts';
import { createMeteringService } from '../../src/routes/metering/index.route.ts';
import { service as modelGatewayService } from '../../src/routes/model-gateway/index.route.ts';
import { createNotifyService } from '../../src/routes/notify/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { service as plannerService } from '../../src/routes/planner/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import { service as resolutionService } from '../../src/routes/resolution/index.route.ts';
import type { ServiceName } from '../../src/config/service.config.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

export const SUPPLIERS = [
  // id, name, registration, rating, email, region
  { id: 's01', name: 'Acme Ltd', reg_no: 'R01', rating: 10, email: 'a@x.test', region: 'north' },
  { id: 's02', name: 'Brill plc', reg_no: 'R02', rating: 11, email: 'b@x.test', region: 'south' },
  { id: 's03', name: 'Cobalt', reg_no: 'R03', rating: 12, email: 'c@x.test', region: 'north' },
  { id: 's04', name: 'Delta', reg_no: 'R04', rating: 10, email: 'd@x.test', region: 'east' },
  { id: 's05', name: 'Echo', reg_no: 'R05', rating: 11, email: 'e@x.test', region: 'south' },
  { id: 's06', name: 'Foxtrot', reg_no: 'R06', rating: 12, email: 'f@x.test', region: 'north' },
  { id: 's07', name: 'Golf', reg_no: 'R07', rating: 10, email: 'g@x.test', region: 'west' },
  { id: 's08', name: 'Hotel', reg_no: 'R08', rating: 11, email: 'h@x.test', region: 'west' },
  { id: 's09', name: 'India', reg_no: 'R09', rating: 12, email: 'shared@x.test', region: 'east' },
  { id: 's10', name: 'Juliet', reg_no: 'R10', rating: 10, email: 'shared@x.test', region: 'south' },
  { id: 's11', name: 'Kilo', reg_no: 'R11', rating: 95, email: null, region: 'north' },
  { id: 's12', name: 'Lima', reg_no: null, rating: 11, email: 'l@x.test', region: 'east' },
];
/** The erp's names differ from crm's for the first five: five disagreements on name. */
export const VENDORS = SUPPLIERS.filter((s) => s.reg_no !== null).map((s, i) => ({
  code: `V${s.id.slice(1)}`, vendor_name: i < 5 ? `${s.name} (erp)` : s.name, registration: s.reg_no,
}));
export const ORDERS = [
  { id: 'o1', supplier_id: 's01', units: 4 }, { id: 'o2', supplier_id: 's01', units: 3 }, { id: 'o3', supplier_id: 's02', units: 5 },
  { id: 'o4', supplier_id: 's03', units: 2 },
];
export const DELIVERIES = [{ id: 'd1', order_id: 'o1' }, { id: 'd2', order_id: 'o1' }, { id: 'd3', order_id: 'o3' }];
export const NOTES = [{ id: 'n1', order_id: 'o1' }];
export const EVENTS = Array.from({ length: 80 }, (_, i) => ({ id: `e${i + 1}`, kind: 'tick' }));

export interface RecognitionCell {
  cell: ConnectCell;
  gateway: ServiceClient;
  root: Signed;
  editor: Signed;
  viewer: Signed;
  crm: string;
  erp: string;
  /** The fake API's base URL (bearer tok_valid). */
  apiUrl: string;
  manifest: OntologyManifest;
  modelRequests: { body: any }[];
  modelReplies: unknown[];
  /** Make a path of the fake API answer 503. */
  failing: Set<string>;
  type(apiName: string): OntologyManifest['objectTypes'][number];
  prop(typeName: string, apiName: string): string;
  link(apiName: string): OntologyManifest['linkTypes'][number];
  keyed(who: Signed): ReturnType<ConnectCell['as']>;
  close(): Promise<void>;
}

export async function startRecognitionCell(services: { definition: ServiceDefinition; name: ServiceName; env?: Record<string, string> }[],
  options: { siloStore?: SiloStoreChannel; executorEnv?: Record<string, string> } = {}): Promise<RecognitionCell> {
  const failing = new Set<string>();
  const api: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer tok_valid') { res.statusCode = 401; res.end('{}'); return; }
    if (failing.has(url.pathname)) { res.statusCode = 503; res.end('{}'); return; }
    const rows: Record<string, unknown[]> = {
      '/v1/suppliers': SUPPLIERS, '/v1/vendors': VENDORS, '/v1/orders': ORDERS, '/v1/deliveries': DELIVERIES, '/v1/notes': NOTES, '/v1/events': EVENTS,
    };
    // The orders resource takes ids (comma-separated), as its manifest declares: a read by key.
    const ids = url.searchParams.get('ids')?.split(',');
    const found = (rows[url.pathname] ?? []) as { id: string }[];
    res.end(JSON.stringify({ results: ids === undefined ? found : found.filter((r) => ids.includes(String(r.id))) }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

  const modelRequests: { body: any }[] = [];
  const modelReplies: unknown[] = [];
  const modelServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      modelRequests.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      const output = modelReplies.shift() ?? { ranking: [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'open-weights-test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }));
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(path.join(tmpdir(), 'silo-recognition-'));
  const tokenFile = path.join(dir, 'token');
  writeFileSync(tokenFile, 'model-token\n');
  const routesFile = path.join(dir, 'routes.json');
  writeFileSync(routesFile, JSON.stringify(['recognition', 'document_extraction', 'fde'].map((role) => ({
    role, provider: 'self_hosted', endpoint: `http://127.0.0.1:${(modelServer.address() as { port: number }).port}`, model: 'open-weights-test',
    region: 'uk-lon-1', zeroRetention: true, auth: { kind: 'bearer_file', file: tokenFile }, maxOutputTokens: 4096,
  }))));

  const cell = await createConnectCell();
  const bounds = { EXECUTOR_MAX_ROWS_PER_SOURCE_STEP: '50', EXECUTOR_MAX_RESULT_ROWS: '1000' };
  await cell.start(ontologyService, 'ontology', 'test_app');
  await cell.start(createConnectRuntimeService(options.siloStore === undefined ? {} : { siloStore: options.siloStore }), 'connect-runtime', 'test_app', bounds);
  await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
  await cell.start(modelGatewayService, 'model-gateway', 'test_model_gateway' as never, { MODEL_ROUTES_FILE: routesFile });
  await cell.start(createMeteringService(), 'metering', 'test_app', { DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: LOCAL.natsUrl });
  await cell.start(createNotifyService(), 'notify', 'test_app', { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_TLS: 'none', NOTIFY_LINK_BASE_URL: 'http://app.test/' });
  // The executor resolves objects of a type held in two systems through the entity graph.
  await cell.start(resolutionService, 'resolution', 'test_app');
  // The object view lists the Action types targeting an object (34.5): actions runs before the executor, as in production.
  await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app');
  await cell.start(plannerService, 'planner', 'test_app', bounds);
  // A service learns the addresses of those started before it: executorEnv names one started later.
  await cell.start(executorService, 'executor', 'test_app', { ...bounds, ...options.executorEnv });
  for (const s of services) await cell.start(s.definition, s.name, 'test_app', s.env);
  const gateway = cell.client('gateway');
  const root = await cell.signIn('root@acme.example');
  const editor = await cell.member('editor@acme.example', 'Super admin');
  const viewer = await cell.member('viewer@acme.example', 'Member');
  const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });
  const source = (p: string) => ({ kind: 'rest', request: { method: 'GET', path: p, query: {} }, records: { jsonata: 'results' } });
  const field = (name: string, type = 'string', nullable = true) => ({ name, type, nullable });

  const activate = async (slug: string, objects: unknown[]) => {
    const connector = await gateway.call(createConnector, { body: { slug, name: slug, provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
    await gateway.call(createManifestVersion, {
      params: { connectorId: connector.id },
      body: {
        document: doc({
          schemaVersion: '1', identity: { name: slug, provider: 'Example', version: '1.0.0' }, transport: { viaAgent: false, baseUrl },
          protocol: { kind: 'rest' }, auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] }, objects,
        }),
      },
    }, keyed(root));
    let connection = await gateway.call(createConnection, { body: { connectorId: connector.id, name: slug, owningScopeId: cell.scopes['engineering']! } }, keyed(root));
    await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'tok_valid' } } }, cell.as(root));
    for (const move of ['probe', 'confirm', 'activate'] as const) {
      if (move === 'confirm') await cell.passConformance(connection.id);
      connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
    }
    return connection.id;
  };
  const crm = await activate('crm', [
    { name: 'suppliers', identifier: ['id'], source: source('/v1/suppliers'),
      fields: [field('id', 'string', false), field('name'), field('reg_no'), field('rating', 'integer'), field('email'), field('region')] },
    { name: 'orders', identifier: ['id'], source: source('/v1/orders'), fields: [field('id', 'string', false), field('supplier_id'), field('units', 'integer')],
      relationships: [{ field: 'supplier_id', targetObject: 'suppliers', targetField: 'id', kind: 'foreign_key' }],
      pushdown: { filters: [{ field: 'id', ops: ['eq', 'in'], patch: { cel: 'op == "in" ? {"query": {"ids": value.join(",")}} : {"query": {"ids": string(value)}}' } }] } },
    { name: 'deliveries', identifier: ['id'], source: source('/v1/deliveries'), fields: [field('id', 'string', false), field('order_id')],
      relationships: [{ field: 'order_id', targetObject: 'orders', targetField: 'id', kind: 'foreign_key' }] },
    { name: 'notes', identifier: ['id'], source: source('/v1/notes'), fields: [field('id', 'string', false), field('order_id')],
      relationships: [{ field: 'order_id', targetObject: 'orders', targetField: 'id', kind: 'foreign_key' }] },
    { name: 'events', identifier: ['id'], source: source('/v1/events'), fields: [field('id', 'string', false), field('kind')] },
  ]);
  const erp = await activate('erp', [
    { name: 'vendors', identifier: ['code'], source: source('/v1/vendors'), fields: [field('code', 'string', false), field('vendor_name'), field('registration')] },
  ]);

  const branch = await gateway.call(openBranch, { body: { name: 'estate' } }, keyed(editor));
  const put = (apiName: string, body: object) => gateway.call(putObjectType, { params: { branchId: branch.id, apiName }, body: body as never }, keyed(editor));
  const m = (connectionId: string, sourceObject: string, fieldPath: string) => ({ connectionId, sourceObject, fieldPath });
  await put('supplier', {
    displayName: 'Supplier', pluralName: 'Suppliers',
    contributingObjects: [{ connectionId: crm, sourceObject: 'suppliers', identifierFieldPath: 'id' }, { connectionId: erp, sourceObject: 'vendors', identifierFieldPath: 'code' }],
    properties: [
      { apiName: 'name', displayName: 'Name', dataType: 'string', mappings: [m(crm, 'suppliers', 'name'), m(erp, 'vendors', 'vendor_name')] },
      { apiName: 'registration', displayName: 'Registration', dataType: 'string', mappings: [m(crm, 'suppliers', 'reg_no'), m(erp, 'vendors', 'registration')] },
      { apiName: 'rating', displayName: 'Rating', dataType: 'integer', mappings: [m(crm, 'suppliers', 'rating')] },
      { apiName: 'email', displayName: 'Email', dataType: 'string', mappings: [m(crm, 'suppliers', 'email')] },
      { apiName: 'region', displayName: 'Region', dataType: 'string', mappings: [m(crm, 'suppliers', 'region')] },
    ],
    title: 'name', matchKeys: [{ property: 'registration', normalisation: 'value.trim()' }],
  });
  for (const [apiName, object, extra] of [['order', 'orders', 'supplier_id'], ['delivery', 'deliveries', 'order_id'], ['note', 'notes', 'order_id']] as const) {
    await put(apiName, {
      displayName: apiName, pluralName: `${apiName}s`, contributingObjects: [{ connectionId: crm, sourceObject: object, identifierFieldPath: 'id' }],
      properties: [
        { apiName: `${apiName}_id`, displayName: 'Id', dataType: 'string', mappings: [m(crm, object, 'id')] },
        { apiName: extra, displayName: extra, dataType: 'string', mappings: [m(crm, object, extra)] },
        ...(apiName === 'order' ? [{ apiName: 'units', displayName: 'Units', dataType: 'integer', mappings: [m(crm, 'orders', 'units')] }] : []),
      ],
      primaryKey: `${apiName}_id`, title: `${apiName}_id`,
    });
  }
  await put('event', {
    displayName: 'Event', pluralName: 'Events', contributingObjects: [{ connectionId: crm, sourceObject: 'events', identifierFieldPath: 'id' }],
    properties: [{ apiName: 'event_id', displayName: 'Id', dataType: 'string', mappings: [m(crm, 'events', 'id')] },
      { apiName: 'kind', displayName: 'Kind', dataType: 'string', mappings: [m(crm, 'events', 'kind')] }],
    primaryKey: 'event_id', title: 'event_id',
  });
  const linkType = (apiName: string, from: string, to: string, sourceObject: string, fk: string) => gateway.call(putLinkType, {
    params: { branchId: branch.id, apiName },
    body: { forwardName: apiName, reverseName: `${apiName} of`, from, to, cardinality: 'one_to_many',
      routes: [{ connectionId: crm, sourceObject, foreignKeyField: fk, referencedField: 'id', origin: 'declared_fk' }], defaultRoute: 0 },
  }, keyed(editor));
  await linkType('supplier_orders', 'supplier', 'order', 'orders', 'supplier_id');
  await linkType('order_deliveries', 'order', 'delivery', 'deliveries', 'order_id');
  await linkType('order_notes', 'order', 'note', 'notes', 'order_id');
  const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Estate' } }, keyed(editor));
  await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
  await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
  const manifest = await gateway.call(getManifest, { query: {} }, cell.as(root));

  // What billing writes from a verified subscription, so simulations can be charged.
  const subscription = uuidv7();
  await inTx(cell.app, { orgId: cell.org }, async () => {
    await cell.app.query(
      `insert into billing.subscriptions (id, organisation_id, plan, seat_count, term, discount_tier, stripe_customer_id, stripe_subscription_id,
         current_period_start, current_period_end, status)
       values ($1, $2, 'business', 10, 'monthly', 'list', 'cus_r', $3, now() - interval '1 day', now() + interval '29 days', 'active')`,
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
  // A first allowance is prorated to what is left of the calendar month. Tests count on the
  // whole of it, whatever the date they run on.
  await inTx(cell.app, { orgId: cell.org }, async () => {
    await cell.app.query(`update billing.token_allowances set tokens_granted = 1000 where organisation_id = $1`, [cell.org]);
    await cell.app.query(`update billing.simulation_allowances set simulations_granted = 5 where organisation_id = $1`, [cell.org]);
  });

  const type = (apiName: string) => manifest.objectTypes.find((t) => t.apiName === apiName)!;
  return {
    cell, gateway, root, editor, viewer, crm, erp, apiUrl: baseUrl, manifest, modelRequests, modelReplies, failing, keyed,
    type,
    prop: (typeName, apiName) => type(typeName).properties.find((p) => p.apiName === apiName)!.identityId,
    link: (apiName) => manifest.linkTypes.find((l) => l.apiName === apiName)!,
    async close() {
      await cell.close();
      api.close();
      modelServer.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
