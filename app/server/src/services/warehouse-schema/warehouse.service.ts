// What the four Warehouse services share (spec 69.12 to 69.23): their dependencies, the
// Warehouse's own service principal as the actor of every internal call, its dataset,
// audit events, the column a property lives in, and the view of a Warehouse.
//
// The Warehouse acts as its automation principal: the principal reads the nominated types
// through the federated engine, holds read grants on their connections, and is bounded by
// its owner (the person who created the Warehouse) at run time, as every principal is
// (spec 60.4). So the Warehouse never holds what its creator could not read.

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import { getManifest, type OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { IndexEventName } from '../../contracts/index-builder/index.contract.ts';
import type { SiloEventName } from '../../contracts/siloes/events.contract.ts';
import type { Nomination, WarehouseEventName, WarehouseTableView, WarehouseView } from '../../contracts/warehouse/warehouse.contract.ts';
import type { WarehouseConfig } from '../../config/warehouse.config.ts';
import type { Config } from '../../config/index.config.ts';
import type { ServiceName } from '../../config/service.config.ts';
import { createBigQueryAdapter, type BigQueryAdapter, type DatasetRef, type TableInfo } from '../../infra/bigquery.infra.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { WarehouseProject } from '../../models/siloes/index.model.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { siloObjectTypeRepo, siloRepo, warehouseSyncRunRepo, warehouseTableRepo } from '../../repos/siloes/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { ColumnType } from './generator/warehouse.generator.ts';

export interface WarehouseDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  bigQuery: BigQueryAdapter;
  config: WarehouseConfig;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

/** The Warehouse's principal as the actor of a call: every internal Warehouse call acts as it. */
export function asWarehouse(project: Pick<WarehouseProject, 'organisationId' | 'servicePrincipalId'>, correlationId: string): Context {
  if (project.servicePrincipalId === null) {
    throw new AppError('integrity', 'the Warehouse has no principal to act as', { code: 'warehouse.no_principal' });
  }
  return { request: { organisationId: project.organisationId, servicePrincipalId: project.servicePrincipalId }, correlationId };
}

export const datasetOf = (project: Pick<WarehouseProject, 'gcpProjectId' | 'dataset'>): DatasetRef => ({
  projectId: project.gcpProjectId, dataset: project.dataset,
});

/** The permission, decided for the caller's actor; a refusal carries the calling service's code. */
export async function demand(deps: Pick<WarehouseDeps, 'services'>, ctx: Context, permission: string, code = 'warehouse.not_permitted'): Promise<void> {
  const answer = await deps.services.call(authorise, { body: { permission } }, { request: ctx.request, correlationId: ctx.correlationId });
  if (answer.decision !== 'allow') {
    throw new AppError('forbidden', `you do not hold ${permission}`, { code, details: { permission } });
  }
}

export function readManifest(deps: Pick<WarehouseDeps, 'services'>, ctx: Context): Promise<OntologyManifest> {
  return deps.services.call(getManifest, { query: {} }, { request: ctx.request, correlationId: ctx.correlationId });
}

/**
 * An audit event in the change's own transaction (every Silo BigQuery service records its
 * events this way). The actor is the person, or the Silo's principal, or the service itself.
 */
export async function recordEvent(db: Queryable, request: RequestContext, correlationId: string, e: {
  event: WarehouseEventName | IndexEventName | SiloEventName; resource: { type: string; id: string } | null;
  detail?: Record<string, string | number | boolean | null>; service?: ServiceName;
}): Promise<void> {
  const actor: AuditActor = request.membershipId !== undefined ? { kind: 'membership', membershipId: request.membershipId }
    : request.servicePrincipalId !== undefined ? { kind: 'service_principal', servicePrincipalId: request.servicePrincipalId }
      : { kind: 'service', service: e.service ?? 'warehouse-provisioner' };
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor, subjectMembershipId: null, scopeId: null, resource: e.resource, purposeSessionId: null,
    operatorAccessSessionId: null, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: request.organisationId!, topic: auditEventMessage.topic, orderingKey: request.organisationId!,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}

// ----------------------------------------------------------------------------- columns

/** A BigQuery column's type, as the generator names it; undefined for one the Warehouse never makes. */
export function columnTypeOf(type: string, mode: string): ColumnType | undefined {
  const base = ({ INTEGER: 'INT64', INT64: 'INT64', BOOLEAN: 'BOOL', BOOL: 'BOOL', STRING: 'STRING', NUMERIC: 'NUMERIC', DATE: 'DATE',
    TIMESTAMP: 'TIMESTAMP', JSON: 'JSON' } as Record<string, ColumnType>)[type.toUpperCase()];
  if (mode === 'REPEATED') return base === 'STRING' ? 'ARRAY<STRING>' : undefined;
  return base;
}

export function existingColumns(info: TableInfo | undefined): Map<string, ColumnType | undefined> {
  return new Map((info?.columns ?? []).map((c) => [c.name, columnTypeOf(c.type, c.mode)]));
}

/**
 * The column a property lives in (spec 69.14): its API name while its type holds; a changed
 * type gets a new versioned column (<name>__v2, __v3...) rather than rewriting history.
 */
export function columnFor(existing: Map<string, ColumnType | undefined>, apiName: string, type: ColumnType): { name: string; exists: boolean } {
  for (let version = 1; ; version += 1) {
    const name = version === 1 ? apiName : `${apiName}__v${version}`;
    if (!existing.has(name)) return { name, exists: false };
    if (existing.get(name) === type) return { name, exists: true };
  }
}

export const historyTableOf = (tableName: string): string => `${tableName}__history`;
export const linkTableOf = (apiName: string): string => `link__${apiName}`;

// ----------------------------------------------------------------------------- the view

/** The Action ledger's mode, as the Silo records it (48.2): off, or on with or without values. */
export const ledgerMode = (silo: { actionLedgerEnabledAt: string | null; actionLedgerIncludeValues: boolean | null }): 'off' | 'references' | 'values' =>
  silo.actionLedgerEnabledAt === null ? 'off' : silo.actionLedgerIncludeValues === true ? 'values' : 'references';

export async function warehouseView(db: Queryable, project: WarehouseProject): Promise<WarehouseView> {
  const silo = (await siloRepo.findById(db, project.siloId))!;
  const nominations = await siloObjectTypeRepo.listLive(db, project.siloId);
  const tables = await warehouseTableRepo.listForProject(db, project.id);
  const runs = new Map((await warehouseSyncRunRepo.latestFor(db, tables.map((t) => t.id))).map((r) => [r.warehouseTableId, r]));
  const tableView = (t: (typeof tables)[number]): WarehouseTableView => {
    const run = runs.get(t.id);
    const freshness = run?.status === 'failed' ? 'stale' : t.lastSyncedAt === null ? 'never' : 'current';
    return {
      id: t.id, kind: t.kind, objectTypeId: t.objectTypeId, linkTypeId: t.linkTypeId, tableName: t.tableName,
      ontologyVersionId: t.ontologyVersionId, lastSyncedAt: t.lastSyncedAt, rowCount: Number(t.rowCount), freshness,
    };
  };
  return {
    id: project.id, siloId: project.siloId, siloStatus: silo.status, purpose: silo.purpose, retentionDays: silo.retentionDays,
    status: project.status, provisioningStep: project.provisioningStep, failedStep: project.failedStep, location: project.location,
    projectId: project.gcpProjectId, dataset: project.dataset,
    nominations: nominations.map((n): Nomination => ({ objectTypeId: n.objectTypeId, properties: n.nominatedProperties })),
    tables: tables.map(tableView), actionLedger: ledgerMode(silo), createdAt: project.createdAt,
  };
}

export function loadView(deps: Pick<WarehouseDeps, 'databases'>, request: RequestContext, project: WarehouseProject): Promise<WarehouseView> {
  return inTransaction(deps.databases.pool('control'), request, (db) => warehouseView(db, project), { readOnly: true });
}

/** The BigQuery adapter a Warehouse service runs on, from the cell's configuration. */
export function bigQueryFrom(config: Config): BigQueryAdapter {
  if (config.bigQuery === undefined) {
    throw new AppError('configuration', 'the Warehouse needs BIGQUERY_PROJECT_ID and BIGQUERY_LOCATION', { code: 'config.bigquery_missing' });
  }
  return createBigQueryAdapter({
    projectId: config.bigQuery.projectId, location: config.bigQuery.location,
    warehouseFolderId: config.warehouse.folderId, billingAccountId: config.warehouse.billingAccountId,
  });
}
