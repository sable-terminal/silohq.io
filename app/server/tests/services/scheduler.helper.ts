// Shared by the scheduler, files and render tests: a cell with the query path running for
// real against a fake system, and the services that act on its answers.
//
// Real processes: credential, policy, auth, connect-registry (from connect.helper),
// ontology, connect-runtime, pushdown-compiler, planner, executor, compile, workspace,
// notify (a fake mailer), files (on the local S3), render and scheduler (its clock moved by
// the test). One REST connection serves invoices from INVOICES, which a test may change.

import { service as canvasLayoutService } from '../../src/routes/canvas-layout/index.route.ts';
import type { Watcher_ } from '../../src/services/scheduler/watch.service.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { freePort } from './writeback.helper.ts';
import { createServer, type Server } from 'node:http';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { compilePlan } from '../../src/contracts/compile/compile.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { putObjectType } from '../../src/contracts/ontology/element.contract.ts';
import { getManifest, type OntologyManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { approveProposal, mergeProposal, openBranch, submitProposal } from '../../src/contracts/ontology/proposal.contract.ts';
import type { QueryPlanInput } from '../../src/contracts/planner/plan.contract.ts';
import { grantConnection } from '../../src/contracts/policy/governance.contract.ts';
import { saveView } from '../../src/contracts/workspace/view.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { service as compileService } from '../../src/routes/compile/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as executorService } from '../../src/routes/executor/index.route.ts';
import { createFilesService } from '../../src/routes/files/index.route.ts';
import { createNotifyService } from '../../src/routes/notify/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { service as plannerService } from '../../src/routes/planner/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import { service as renderService } from '../../src/routes/render/index.route.ts';
import { createSchedulerService } from '../../src/routes/scheduler/index.route.ts';
import { createWorkspaceService, type WorkspaceOptions } from '../../src/routes/workspace/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { dropTestBucket, LOCAL } from '../infra/services.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';
import { createSiloesImportService } from '../../src/routes/siloes-import/index.route.ts';
import { createMemoryStore } from './memoryStore.helper.ts';

export interface Invoice { id: string; customer: string; total: number; status: string }

export const INVOICES: Invoice[] = [];
export const resetInvoices = (): void => {
  INVOICES.splice(0, INVOICES.length,
    { id: 'i1', customer: 'Acme Ltd', total: 120, status: 'open' },
    { id: 'i2', customer: '=HYPERLINK("http://evil.example")', total: 80, status: 'paid' },
    { id: 'i3', customer: 'Brill, plc', total: 300, status: 'open' });
};

/** The scheduler's clock: Date.now() plus this offset, moved by a test. */
export const clock = { offset: 0 };

export interface FilesCell {
  cell: ConnectCell;
  gateway: ServiceClient;
  root: Signed;
  /** A member with read access to the connection: makes views, Crons and exports. */
  member: Signed;
  /** A member with no grant on the connection. */
  outsider: Signed;
  crm: string;
  memberGrantId: string;
  manifest: OntologyManifest;
  bucket: string;
  s3: S3Client;
  keyed(who: Signed): ReturnType<ConnectCell['as']>;
  /** The invoice type's property identity by API name. */
  prop(apiName: string): string;
  /** A saved view of a plan, owned by `who`: its view id and plan id. */
  view(who: Signed, plan: Omit<QueryPlanInput, 'schemaVersion' | 'ontologyVersionId'>, name: string): Promise<{ viewId: string; planId: string }>;
  apiDown: { value: boolean };
  /** With `watch`: the scheduler's watch, refreshed by the test. */
  watcher: Watcher_ | undefined;
  close(): Promise<void>;
}

/**
 * With `writes`: the invoices take updates (PATCH by id, read back by id), the connection has
 * earned writes, and actions and approvals run, for Crons that mutate (spec 40.5).
 */
export async function createFilesCell(extra: { files?: Record<string, string>; writes?: boolean; watch?: boolean; canvas?: boolean; siloes?: boolean; workspace?: WorkspaceOptions } = {}): Promise<FilesCell> {
  resetInvoices();
  const apiDown = { value: false };
  const api: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (apiDown.value) {
      res.statusCode = 503;
      res.end('{}');
      return;
    }
    if (req.headers.authorization !== 'Bearer tok_valid') {
      res.statusCode = 401;
      res.end('{}');
      return;
    }
    const url = new URL(req.url!, 'http://x');
    const one = /^\/v1\/invoices\/([^/]+)$/.exec(url.pathname);
    if (extra.writes && req.method === 'PATCH' && one !== null) {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        const found = INVOICES.find((i) => i.id === decodeURIComponent(one[1]!));
        if (found === undefined) {
          res.statusCode = 404;
          res.end('{}');
          return;
        }
        Object.assign(found, JSON.parse(raw === '' ? '{}' : raw));
        res.end(JSON.stringify(found));
      });
      return;
    }
    const id = url.searchParams.get('id');
    res.end(JSON.stringify({ results: url.pathname === '/v1/invoices' ? INVOICES.filter((i) => id === null || i.id === id) : [] }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

  const bucket = `silo-files-${uuidv7().slice(-12)}`;
  const s3 = new S3Client({
    endpoint: LOCAL.s3Endpoint, region: 'eu-west-2', forcePathStyle: true, credentials: { accessKeyId: 'local', secretAccessKey: 'local-secret' },
  });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));

  const cell = await createConnectCell();
  const s3Env = {
    OBJECT_STORE: 's3', OBJECT_BUCKET_FILES: bucket, S3_ENDPOINT: LOCAL.s3Endpoint, S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: 'local', S3_SECRET_ACCESS_KEY: 'local-secret',
  };
  await cell.start(ontologyService, 'ontology', 'test_app');
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
  await cell.start(plannerService, 'planner', 'test_app');
  await cell.start(executorService, 'executor', 'test_app');
  await cell.start(compileService, 'compile', 'test_app');
  await cell.start(createNotifyService({ mailer: { async send() {}, close() {} } }), 'notify', 'test_app', {
    SMTP_HOST: '127.0.0.1', SMTP_TLS: 'none', NOTIFY_LINK_BASE_URL: 'https://app.example',
  });
  // Import Siloes, where a pipeline writes (D235) and a media set keeps its items (D237): in memory,
  // before files and workspace, which call them.
  if (extra.siloes) {
    await cell.start(createSiloesImportService({ store: createMemoryStore(), schedule: false }), 'siloes-import', 'test_app', {
      OBJECT_STORE: 's3', OBJECT_BUCKET_SILOES: 'silo-test-siloes', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true',
      SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02', HTTP_PORT: String(await freePort()),
    });
  }
  await cell.start(createFilesService(), 'files', 'test_app', { ...s3Env, HTTP_MAX_BODY_BYTES: String(8 * 1024 * 1024), ...extra.files });
  await cell.start(renderService, 'render', 'test_app');
  // Workspace files a workbook's export (D232): it starts after Files.
  await cell.start(createWorkspaceService(extra.workspace ?? {}), 'workspace', 'test_app');
  // canvas-layout calls the executor and files: it starts after them.
  if (extra.canvas) await cell.start(canvasLayoutService, 'canvas-layout', 'test_app', { REDIS_STATE_URL: `${LOCAL.redisUrl}/2` });
  // The scheduler calls actions (a Cron that mutates): actions start first.
  if (extra.writes) {
    const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
    await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
    await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
  }
  let watcher: Watcher_ | undefined;
  await cell.start(createSchedulerService({
    now: () => Date.now() + clock.offset, ...(extra.watch ? { watch: true, watchRefreshMs: 600_000, onWatcher: (w: Watcher_) => { watcher = w; } } : {}),
  }), 'scheduler', 'test_app', { SCHEDULER_TICK_MS: '150', ...(extra.watch ? { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl } : {}) });

  const gateway = cell.client('gateway');
  const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });
  const root = await cell.signIn('root@acme.example');
  const member = await cell.member('member@acme.example', 'Member');
  const outsider = await cell.member('outsider@acme.example', 'Member');

  // One system, active, owned by root.
  const connector = await gateway.call(createConnector, { body: { slug: 'crm', name: 'crm', provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
  await gateway.call(createManifestVersion, {
    params: { connectorId: connector.id },
    body: { document: doc({
      schemaVersion: '1', identity: { name: 'Accounts', provider: 'Example', version: '1.0.0' },
      transport: { viaAgent: false, baseUrl }, protocol: { kind: 'rest' },
      auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
      objects: [{
        name: 'invoices', identifier: ['id'],
        source: { kind: 'rest', request: { method: 'GET', path: '/v1/invoices', query: {} }, records: { jsonata: 'results' } },
        fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'customer', type: 'string' }, { name: 'total', type: 'number' },
          { name: 'status', type: 'string' }, ...(extra.watch ? [{ name: 'updated_at', type: 'date-time' }] : [])],
        ...(extra.watch ? { pushdown: { filters: [{ field: 'updated_at', ops: ['gt'], patch: { cel: '{"query": {"since": string(value)}}' } }] } } : {}),
        ...(extra.writes ? {
          pushdown: { filters: [{ field: 'id', ops: ['eq'], patch: { cel: '{"query": {"id": string(value)}}' } }] },
          writes: { update: { request: { method: 'PATCH', path: '/v1/invoices/{identifier}' } }, bounds: { maxRows: 100 } },
        } : {}),
      }],
      ...(extra.watch ? { changeStream: { objects: [{ object: 'invoices', sources: [{ kind: 'poll', intervalSeconds: 300, watermarkField: 'updated_at' }] }] } } : {}),
    }) },
  }, keyed(root));
  let connection = await gateway.call(createConnection, {
    body: { connectorId: connector.id, name: 'crm', owningScopeId: cell.scopes['engineering']! },
  }, keyed(root));
  await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'tok_valid' } } }, cell.as(root));
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(connection.id);
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
  }
  const crm = connection.id;
  if (extra.writes) await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('update connect.connections set writes_enabled = true where id = $1', [crm]));
  const grant = await gateway.call(grantConnection, {
    body: { connectionId: crm, grantee: { kind: 'membership', id: member.membershipId }, access: 'read' },
  }, cell.as(root));

  const branch = await gateway.call(openBranch, { body: { name: 'billing' } }, keyed(root));
  const m = (fieldPath: string) => ({ connectionId: crm, sourceObject: 'invoices', fieldPath });
  await gateway.call(putObjectType, {
    params: { branchId: branch.id, apiName: 'invoice' },
    body: {
      displayName: 'Invoice', pluralName: 'Invoices',
      contributingObjects: [{ connectionId: crm, sourceObject: 'invoices', identifierFieldPath: 'id' }],
      properties: [
        { apiName: 'invoice_id', displayName: 'Invoice number', dataType: 'string', mappings: [m('id')] },
        { apiName: 'customer', displayName: 'Customer', dataType: 'string', mappings: [m('customer')] },
        { apiName: 'total', displayName: 'Total', dataType: 'decimal', mappings: [m('total')] },
        { apiName: 'status', displayName: 'Status', dataType: 'string', mappings: [m('status')] },
      ],
      primaryKey: 'invoice_id', title: 'invoice_id',
    } as never,
  }, keyed(root));
  const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Billing' } }, keyed(root));
  const approver = await cell.member('approver@acme.example', 'Super admin');
  await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(approver));
  await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
  const manifest = await gateway.call(getManifest, { query: {} }, cell.as(root));
  const invoice = manifest.objectTypes.find((t) => t.apiName === 'invoice')!;
  const prop = (apiName: string) => invoice.properties.find((p) => p.apiName === apiName)!.identityId;

  return {
    cell, gateway, root, member, outsider, crm, memberGrantId: grant.id, manifest, bucket, s3, keyed, prop, apiDown, watcher,
    async view(who, body, name) {
      const plan: QueryPlanInput = { schemaVersion: '1', ontologyVersionId: manifest.version.id, ...body };
      const compiled = await gateway.call(compilePlan, { body: { plan, execute: false } }, cell.as(who));
      if (compiled.outcome === 'refusal') throw new Error(`the plan was refused: ${compiled.refusal.code}`);
      const saved = await gateway.call(saveView, { body: { kind: 'result', name, manifestId: compiled.planId } }, keyed(who));
      return { viewId: saved.id, planId: compiled.planId };
    },
    async close() {
      await cell.close();
      api.close();
      await dropTestBucket(s3, bucket);
      s3.destroy();
    },
  };
}

/** The invoice type's id in the manifest. */
export const invoiceType = (manifest: OntologyManifest): string => manifest.objectTypes.find((t) => t.apiName === 'invoice')!.id;

/** Polls until the check returns a value, or fails after the timeout. */
export async function until<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
