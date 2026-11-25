// warehouse-access (spec 69.16, 69.17, 69.20): direct SQL grants for a customer's analysts,
// refused and withdrawn wherever marked data is held, and the Warehouse's exit.
//
// - A grant is applied in BigQuery (dataViewer on the dataset, jobUser on the project) and
//   then recorded with its audit event; a record that fails takes the access back off.
// - The marking check reads every marking on what the Warehouse holds, whatever the reader
//   may see, so a marking can never hide itself from the check.
// - Hand-over: grants end, Silo's writers leave, the project moves under the customer's
//   organisation or folder, and the Silo is disabled. The dataset stays encrypted with the
//   organisation's Warehouse key until the customer re-keys it; that key is not destroyed
//   by a hand-over.
// - Export: each table as Parquet into object-files beside schema.json and lineage.json.

import type { SqlGrantView } from '../../contracts/warehouse/access.contract.ts';
import type { WarehouseConfig } from '../../config/warehouse.config.ts';
import type { BigQueryAdapter } from '../../infra/bigquery.infra.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { objectKey, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { inTransaction, type Databases, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { WarehouseProject, WarehouseSqlGrant } from '../../models/siloes/index.model.ts';
import { siloObjectTypeRepo, siloRepo, warehouseProjectRepo, warehouseSqlGrantRepo, warehouseTableRepo } from '../../repos/siloes/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { truncateTable } from '../warehouse-schema/generator/warehouse.generator.ts';
import { requireSiloes } from '../siloes-capture/deps.service.ts';
import { datasetOf, demand, recordEvent } from '../warehouse-schema/warehouse.service.ts';

export interface AccessDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  bigQuery: BigQueryAdapter;
  config: WarehouseConfig;
  /** object-files, for exports; undefined where the cell has no object storage. */
  store: ObjectStore | undefined;
  filesBucket: string | undefined;
}

type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'caller'>;


/** The IAM member of a Google identity: a service account by its domain, otherwise a user. */
export const memberOf = (identity: string): string =>
  identity.endsWith('.gserviceaccount.com') ? `serviceAccount:${identity}` : `user:${identity}`;

function person(ctx: Context): string {
  if (ctx.request.membershipId === undefined) {
    throw new AppError('forbidden', 'direct SQL access is granted by a person', { code: 'warehouse.person_required' });
  }
  return ctx.request.membershipId;
}

export function grantView(g: WarehouseSqlGrant): SqlGrantView {
  return {
    id: g.id, warehouseId: g.warehouseProjectId, googleIdentity: g.googleIdentity, grantedBy: g.grantedBy, grantedAt: g.grantedAt,
    revokedBy: g.revokedBy, revokedAt: g.revokedAt, revokedReason: g.revokedReason,
  };
}

async function loadProject(db: Queryable, warehouseId: string): Promise<WarehouseProject> {
  const project = await warehouseProjectRepo.findById(db, warehouseId);
  if (project === undefined) throw new AppError('not_found', 'no such Warehouse', { code: 'warehouse.not_found' });
  return project;
}

/** Whether any marking reaches what the Warehouse holds: types, nominated properties, their connections, the Silo. */
async function marked(db: Queryable, project: WarehouseProject): Promise<{ markings: number; objectTypes: number }> {
  const rows = await siloObjectTypeRepo.markingsOnHeld(db, project.siloId);
  return { markings: new Set(rows.map((r) => r.markingId)).size, objectTypes: new Set(rows.flatMap((r) => r.objectTypeId ?? [])).size };
}

// ----------------------------------------------------------------------------- grants

export async function grantSqlAccess(deps: AccessDeps, ctx: Context, warehouseId: string, googleIdentity: string): Promise<SqlGrantView> {
  const granter = person(ctx);
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'warehouse.sql_access');
  const pool = deps.databases.pool('control');
  const { project, live } = await inTransaction(pool, ctx.request, async (db) => {
    const project = await loadProject(db, warehouseId);
    if (project.status !== 'active') throw new AppError('conflict', 'direct access is granted on an active Warehouse', { code: 'warehouse.not_active' });
    const found = await marked(db, project);
    if (found.markings > 0) {
      throw new AppError('forbidden', 'the Warehouse holds marked data, which BigQuery cannot enforce: direct access is refused', {
        code: 'warehouse.marked_data', details: { markings: found.markings, objectTypes: found.objectTypes },
      });
    }
    const live = (await warehouseSqlGrantRepo.listForProject(db, project.id, true)).find((g) => g.googleIdentity === googleIdentity);
    return { project, live };
  }, { readOnly: true });
  if (live !== undefined) return grantView(live);

  const member = memberOf(googleIdentity);
  const ref = datasetOf(project);
  await deps.bigQuery.grantDatasetAccess(ref, member, 'reader');
  await deps.bigQuery.grantJobUser(project.gcpProjectId, member);
  try {
    const row = await inTransaction(pool, ctx.request, async (db) => {
      const row = await warehouseSqlGrantRepo.insert(db, {
        id: uuidv7(), organisationId: project.organisationId, warehouseProjectId: project.id, googleIdentity, grantedBy: granter,
      });
      // Read first by a reviewer: the only way a person reaches the Warehouse outside Silo's gates.
      await recordEvent(db, ctx.request, ctx.correlationId, {
        event: 'warehouse_sql_access_granted', resource: { type: 'warehouse', id: project.id },
        detail: { grant_id: row.id, google_identity: googleIdentity },
      });
      return row;
    });
    return grantView(row);
  } catch (error) {
    await removeAccess(deps, project, member).catch((undo: unknown) => {
      deps.logger.failure('a direct SQL grant that was not recorded could not be taken back', undo, { event: 'warehouse.grant_undo_failed', organisationId: project.organisationId });
    });
    throw error;
  }
}

async function removeAccess(deps: AccessDeps, project: WarehouseProject, member: string): Promise<void> {
  await deps.bigQuery.revokeDatasetAccess(datasetOf(project), member);
  await deps.bigQuery.revokeJobUser(project.gcpProjectId, member);
}

/** Ends a grant: in BigQuery first, then on record. A person names themselves; the system names its reason. */
async function endGrant(deps: AccessDeps, request: RequestContext, correlationId: string, project: WarehouseProject, grant: WarehouseSqlGrant,
  reason: 'revoked' | 'marked_data' | 'handed_over' | 'purged'): Promise<WarehouseSqlGrant> {
  await removeAccess(deps, project, memberOf(grant.googleIdentity));
  return inTransaction(deps.databases.pool('control'), request, async (db) => {
    const row = (await warehouseSqlGrantRepo.update(db, grant.id, {
      revokedAt: new Date().toISOString(), revokedReason: reason, revokedBy: reason === 'revoked' ? request.membershipId! : null,
    }))!;
    await recordEvent(db, request, correlationId, {
      event: 'warehouse_sql_access_revoked', resource: { type: 'warehouse', id: project.id },
      detail: { grant_id: grant.id, google_identity: grant.googleIdentity, reason }, service: 'warehouse-access',
    });
    return row;
  });
}

export async function revokeSqlAccess(deps: AccessDeps, ctx: Context, warehouseId: string, grantId: string): Promise<SqlGrantView> {
  person(ctx);
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'warehouse.sql_access');
  const { project, grant } = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const project = await loadProject(db, warehouseId);
    const grant = await warehouseSqlGrantRepo.findById(db, grantId);
    if (grant === undefined || grant.warehouseProjectId !== project.id) throw new AppError('not_found', 'no such grant', { code: 'warehouse.grant_not_found' });
    return { project, grant };
  }, { readOnly: true });
  if (grant.revokedAt !== null) return grantView(grant);
  return grantView(await endGrant(deps, ctx.request, ctx.correlationId, project, grant, 'revoked'));
}

export async function listSqlGrants(deps: AccessDeps, ctx: Context, warehouseId: string): Promise<{ grants: SqlGrantView[] }> {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'warehouse.sql_access');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const project = await loadProject(db, warehouseId);
    return { grants: (await warehouseSqlGrantRepo.listForProject(db, project.id, false)).map(grantView) };
  }, { readOnly: true });
}

/** The marking check (69.16): a Warehouse holding marked data keeps no direct access. Returns the grants ended. */
export async function enforceMarkings(deps: AccessDeps, organisationId: string, warehouseId: string, correlationId: string): Promise<number> {
  const request: RequestContext = { organisationId };
  const { project, live, found } = await inTransaction(deps.databases.pool('control'), request, async (db) => {
    const project = await loadProject(db, warehouseId);
    return { project, live: await warehouseSqlGrantRepo.listForProject(db, project.id, true), found: await marked(db, project) };
  }, { readOnly: true });
  if (found.markings === 0 || live.length === 0) return 0;
  for (const grant of live) await endGrant(deps, request, correlationId, project, grant, 'marked_data');
  return live.length;
}

// ----------------------------------------------------------------------------- exit

export async function handOver(deps: AccessDeps, ctx: Context, warehouseId: string, destination: string)
  : Promise<{ warehouseId: string; status: 'handed_over'; handedOverAt: string; destination: string; grantsRevoked: number }> {
  person(ctx);
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.purge');
  const pool = deps.databases.pool('control');
  const { project, live } = await inTransaction(pool, ctx.request, async (db) => {
    const project = await loadProject(db, warehouseId);
    if (project.status === 'handed_over' || project.status === 'purged') {
      throw new AppError('conflict', 'the Warehouse is no longer Silo\'s to hand over', { code: 'warehouse.closed' });
    }
    return { project, live: await warehouseSqlGrantRepo.listForProject(db, project.id, true) };
  }, { readOnly: true });
  for (const grant of live) await endGrant(deps, ctx.request, ctx.correlationId, project, grant, 'handed_over');
  const ref = datasetOf(project);
  for (const member of deps.config.writerMembers) {
    await deps.bigQuery.revokeDatasetAccess(ref, member);
    await deps.bigQuery.revokeJobUser(project.gcpProjectId, member);
  }
  try {
    await deps.bigQuery.moveProject(project.gcpProjectId, destination);
  } catch (error) {
    // Not moved: Silo's writers come back, so the Warehouse keeps syncing.
    for (const member of deps.config.writerMembers) {
      await deps.bigQuery.grantDatasetAccess(ref, member, 'writer').catch(() => undefined);
      await deps.bigQuery.grantJobUser(project.gcpProjectId, member).catch(() => undefined);
    }
    throw error;
  }
  const handedOverAt = new Date().toISOString();
  await inTransaction(pool, ctx.request, async (db) => {
    await warehouseProjectRepo.update(db, project.id, { status: 'handed_over', handedOverAt });
    await siloRepo.update(db, project.siloId, { status: 'disabled', disabledAt: handedOverAt });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'warehouse_handed_over', resource: { type: 'warehouse', id: project.id }, detail: { destination, grants_revoked: live.length },
    });
  });
  return { warehouseId: project.id, status: 'handed_over', handedOverAt, destination, grantsRevoked: live.length };
}

async function waitForJob(deps: AccessDeps, projectId: string, jobId: string): Promise<void> {
  for (let i = 0; i < 360; i += 1) {
    const status = await deps.bigQuery.jobStatus(projectId, jobId);
    if (status.state === 'done') {
      if (status.failed) throw new AppError('upstream', 'an export job failed', { code: 'warehouse.export_failed', details: { reason: status.errorCode ?? 'unknown' } });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(500 * (i + 1), 5_000)));
  }
  throw new AppError('timeout', 'an export job did not finish', { code: 'warehouse.export_timeout' });
}

export async function exportTables(deps: AccessDeps, ctx: Context, warehouseId: string): Promise<{
  exportId: string; tables: { table: string; kind: string; uri: string; jobId: string }[]; schemaKey: string; lineageKey: string;
}> {
  if (ctx.caller === 'gateway') {
    await requireSiloes(deps, ctx);
    await demand(deps, ctx, 'silo.manage');
  }
  if (deps.store === undefined || deps.filesBucket === undefined) {
    throw new AppError('configuration', 'a Warehouse export needs object storage', { code: 'config.warehouse_export_storage' });
  }
  const { project, tables, nominations } = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const project = await loadProject(db, warehouseId);
    if (project.status === 'purged') throw new AppError('conflict', 'the Warehouse was purged', { code: 'warehouse.closed' });
    return {
      project, tables: (await warehouseTableRepo.listForProject(db, project.id)).filter((t) => t.droppedAt === null),
      nominations: await siloObjectTypeRepo.listLive(db, project.siloId),
    };
  }, { readOnly: true });
  const exportId = uuidv7();
  const organisationId = project.organisationId;
  const ref = datasetOf(project);
  const options = { labels: { organisation: organisationId, service: 'warehouse-access', purpose: 'export' as const } };
  const out: { table: string; kind: string; uri: string; jobId: string }[] = [];
  const schema: Record<string, unknown> = {};
  for (const t of tables) {
    const prefix = objectKey.organisation(organisationId, 'exports', exportId, 'warehouse', t.tableName);
    const uri = `gs://${deps.filesBucket}/${prefix}/part-*.parquet`;
    const { jobId } = await deps.bigQuery.exportTable({ ...ref, table: t.tableName }, { destinationUri: uri, format: 'PARQUET' }, options);
    await waitForJob(deps, project.gcpProjectId, jobId);
    schema[t.tableName] = { kind: t.kind, columns: (await deps.bigQuery.getTable({ ...ref, table: t.tableName }))?.columns ?? [] };
    out.push({ table: t.tableName, kind: t.kind, uri, jobId });
  }
  const lineage = {
    warehouseId: project.id, exportedAt: new Date().toISOString(), location: project.location,
    nominations: nominations.map((n) => ({ objectTypeId: n.objectTypeId, properties: n.nominatedProperties })),
    tables: tables.map((t) => ({
      table: t.tableName, kind: t.kind, objectTypeId: t.objectTypeId, linkTypeId: t.linkTypeId, ontologyVersionId: t.ontologyVersionId,
      lastSyncedAt: t.lastSyncedAt, rows: Number(t.rowCount),
    })),
  };
  const schemaKey = objectKey.organisation(organisationId, 'exports', exportId, 'warehouse', 'schema.json');
  const lineageKey = objectKey.organisation(organisationId, 'exports', exportId, 'warehouse', 'lineage.json');
  await deps.store.put('files', schemaKey, Buffer.from(JSON.stringify(schema, null, 2)), 'application/json');
  await deps.store.put('files', lineageKey, Buffer.from(JSON.stringify(lineage, null, 2)), 'application/json');
  return { exportId, tables: out, schemaKey, lineageKey };
}

// ----------------------------------------------------------------------------- purge

/**
 * Disable and purge (69.20, 70.2), from the Silo purge path: grants end, the dataset and the
 * project go, and the organisation's Warehouse key versions are scheduled for destruction, so
 * the data is unrecoverable by key as well as by deletion (design: Encryption).
 */
export async function purgeWarehouse(deps: AccessDeps, ctx: Context, warehouseId: string)
  : Promise<{ dataset: string; projectDeleted: boolean; keyDestroyed: boolean; grantsRevoked: number; tables: number }> {
  const pool = deps.databases.pool('control');
  const { project, live, tables } = await inTransaction(pool, ctx.request, async (db) => {
    const project = await loadProject(db, warehouseId);
    return {
      project, live: await warehouseSqlGrantRepo.listForProject(db, project.id, true),
      tables: (await warehouseTableRepo.listForProject(db, project.id)).filter((t) => t.droppedAt === null),
    };
  }, { readOnly: true });
  if (project.status === 'purged') return { dataset: project.dataset, projectDeleted: false, keyDestroyed: false, grantsRevoked: 0, tables: 0 };
  for (const grant of live) await endGrant(deps, ctx.request, ctx.correlationId, project, grant, 'purged');
  if (project.status !== 'handed_over') {
    await deps.bigQuery.deleteDataset(datasetOf(project));
  }
  const projectDeleted = project.status === 'handed_over' ? false : (await deps.bigQuery.deleteProject(project.gcpProjectId)).deleted;
  await deps.bigQuery.destroyKey(project.kmsKeyRef);
  const at = new Date().toISOString();
  await inTransaction(pool, ctx.request, async (db) => {
    for (const t of tables) await warehouseTableRepo.update(db, t.id, { droppedAt: at });
    await warehouseProjectRepo.update(db, project.id, { status: 'purged', purgedAt: at });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'warehouse_purged', resource: { type: 'warehouse', id: project.id },
      detail: { dataset: project.dataset, project: project.gcpProjectId, tables: tables.length, grants_revoked: live.length }, service: 'warehouse-access',
    });
  });
  return { dataset: project.dataset, projectDeleted, keyDestroyed: true, grantsRevoked: live.length, tables: tables.length };
}

/** Purge concept (70.2): every row of one object type's current and history tables. */
export async function purgeWarehouseType(deps: AccessDeps, ctx: Context, warehouseId: string, objectTypeId: string): Promise<{ tables: number; rowsDeleted: number }> {
  const { project, tables } = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const project = await loadProject(db, warehouseId);
    return { project, tables: (await warehouseTableRepo.listForProject(db, project.id)).filter((t) => t.objectTypeId === objectTypeId && t.droppedAt === null) };
  }, { readOnly: true });
  if (project.status === 'purged' || project.status === 'handed_over') return { tables: 0, rowsDeleted: 0 };
  const ref = datasetOf(project);
  const labels = { organisation: project.organisationId, service: 'warehouse-access', purpose: 'warehouse_sync' as const };
  let rowsDeleted = 0;
  for (const t of tables) rowsDeleted += (await deps.bigQuery.run(ref, truncateTable(ref, t.tableName), { labels })).affectedRows ?? 0;
  return { tables: tables.length, rowsDeleted };
}
