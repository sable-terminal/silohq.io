// warehouse-sync (spec 69.15): reads each nominated object type through the federated
// engine, as the Warehouse's principal, and writes its current and history tables.
//
// - Backfill and scheduled syncs read the whole type through the executor, whose bounds and
//   per-connection rate limits keep a customer system within its declared limits. A type
//   larger than the executor's bounds is refused there, with the bound named, and the table
//   is left stale rather than half-written as current.
// - Each value is written as the engine answers it: a disputed property is null with its
//   dispute flag and the count of sources mapping it; a value the principal may only see
//   masked or redacted is not stored at all (null). Nothing outside the nominated
//   properties is read.
// - A history row is written for each property whose value changed since the last write,
//   found by comparing hashes of Silo's own canonical values, never BigQuery's rendering.
// - Each run is a siloes.warehouse_sync_runs row; a failed run marks the table stale.
// Change streams write between syncs through the Siloes' observation queue (observations.service.ts).

import { createHash } from 'node:crypto';
import { readResultPage, runPlan, type ResultObject } from '../../contracts/executor/result.contract.ts';
import { PLAN_SCHEMA_VERSION } from '../../contracts/planner/plan.contract.ts';
import { applyWarehouseSchema } from '../../contracts/warehouse/warehouse.contract.ts';
import type { DatasetRef } from '../../infra/bigquery.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { SiloObjectType, WarehouseProject, WarehouseTable } from '../../models/siloes/index.model.ts';
import { siloObjectTypeRepo, warehouseProjectRepo, warehouseSyncRunRepo, warehouseTableRepo } from '../../repos/siloes/index.repo.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  countRows, FIRST_OBSERVED_COLUMN, HASHES_COLUMN, insertHistory, insertLinks, mergeCurrent, propertyColumns, readCurrent, ID_COLUMN, LINEAGE_COLUMNS,
  truncateTable, type Column,
  type ColumnType,
} from '../warehouse-schema/generator/warehouse.generator.ts';
import { nominatedProperties, type NominatedProperty } from '../warehouse-schema/schema.service.ts';
import {
  asWarehouse, columnFor, datasetOf, existingColumns, historyTableOf, readManifest, recordEvent, type Context, type WarehouseDeps,
} from '../warehouse-schema/warehouse.service.ts';

export type SyncMode = 'backfill' | 'scheduled' | 'reconcile';

interface Target {
  project: WarehouseProject;
  nomination: SiloObjectType;
  table: WarehouseTable;
}

/** Starts a sync of each nominated type (all, or those named); each runs detached and records itself. */
export async function startSync(deps: WarehouseDeps, ctx: Context, warehouseId: string, mode: SyncMode, objectTypeIds?: string[])
  : Promise<{ started: { objectTypeId: string; tableId: string }[] }> {
  const pool = deps.databases.pool('control');
  const { project, targets } = await inTransaction(pool, ctx.request, async (db) => {
    const project = await warehouseProjectRepo.findById(db, warehouseId);
    if (!project) throw new AppError('not_found', 'no such Warehouse', { code: 'warehouse.not_found' });
    if (project.status === 'handed_over' || project.status === 'purged') {
      throw new AppError('conflict', 'the Warehouse is no longer Silo\'s to write', { code: 'warehouse.closed' });
    }
    const tables = await warehouseTableRepo.listForProject(db, project.id);
    const wanted = objectTypeIds === undefined ? undefined : new Set(objectTypeIds);
    const targets: Target[] = [];
    for (const nomination of await siloObjectTypeRepo.listLive(db, project.siloId)) {
      if (wanted !== undefined && !wanted.has(nomination.objectTypeId)) continue;
      const table = tables.find((t) => t.kind === 'current' && t.objectTypeId === nomination.objectTypeId);
      if (table !== undefined) targets.push({ project, nomination, table });
    }
    return { project, targets };
  }, { readOnly: true });

  const principal = asWarehouse(project, ctx.correlationId);
  const runs = await inTransaction(pool, principal.request, async (db) => {
    const out: { target: Target; runId: string }[] = [];
    for (const target of targets) {
      const runId = uuidv7();
      await warehouseSyncRunRepo.insert(db, { id: runId, organisationId: project.organisationId, warehouseTableId: target.table.id, mode });
      out.push({ target, runId });
    }
    return out;
  });
  for (const { target, runId } of runs) {
    void syncType(deps, principal, target, runId, mode).catch((error: unknown) => {
      deps.logger.failure('a Warehouse sync failed outside its run record', error, { event: 'warehouse.sync_crashed', organisationId: project.organisationId });
    });
  }
  return { started: runs.map((r) => ({ objectTypeId: r.target.nomination.objectTypeId, tableId: r.target.table.id })) };
}

export const hashOf = (value: unknown, disputed: boolean): string =>
  createHash('sha256').update(canonicalJson({ v: value ?? null, d: disputed })).digest('hex');

/** A value as its column binds it. */
export function bind(value: unknown, type: ColumnType): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'JSON': return JSON.stringify(value);
    case 'NUMERIC': return String(value);
    case 'INT64': return typeof value === 'number' ? value : Number(value);
    case 'BOOL': return Boolean(value);
    case 'ARRAY<STRING>': return Array.isArray(value) ? value.map(String) : [String(value)];
    default: return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

/** Every object of the answer, page by page, while the result lives in the data plane. */
export async function allObjects(deps: Pick<WarehouseDeps, 'services'>, ctx: Context, queryId: string, first: ResultObject[], total: number): Promise<ResultObject[]> {
  const objects = [...first];
  for (let page = 1; objects.length < total; page += 1) {
    const next = await deps.services.call(readResultPage, { params: { queryId, page } }, { request: ctx.request, correlationId: ctx.correlationId });
    if (next.objects.length === 0) break;
    objects.push(...next.objects);
  }
  return objects;
}

async function syncType(deps: WarehouseDeps, ctx: Context, target: Target, runId: string, mode: SyncMode): Promise<void> {
  const pool = deps.databases.pool('control');
  const { project, nomination, table } = target;
  const ref: DatasetRef = datasetOf(project);
  const options = { labels: { organisation: project.organisationId, service: 'warehouse-sync', purpose: 'warehouse_sync' as const } };
  let rowsWritten = 0;
  let bytesScanned = 0;
  try {
    const manifest = await readManifest(deps, ctx);
    const properties = nominatedProperties(manifest, nomination.objectTypeId, nomination.nominatedProperties);
    let existing = existingColumns(await deps.bigQuery.getTable({ ...ref, table: table.tableName }));
    if (properties.some((p) => !columnFor(existing, p.apiName, p.type).exists)) {
      // The ontology moved on since the tables were made: bring them level first (spec 69.14).
      await deps.services.call(applyWarehouseSchema, { params: { warehouseId: project.id } }, { request: ctx.request, correlationId: ctx.correlationId });
      existing = existingColumns(await deps.bigQuery.getTable({ ...ref, table: table.tableName }));
    }
    const columnOf = new Map(properties.map((p) => [p.apiName, columnFor(existing, p.apiName, p.type).name]));

    const outcome = await deps.services.call(runPlan, {
      body: {
        plan: {
          schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: manifest.version.id,
          nodes: [{ objectTypeId: nomination.objectTypeId, filters: [] }], hops: [],
          select: properties.map((p) => ({ node: 0, property: p.identityId })), sort: [],
        },
        parameters: {}, trigger: 'structured', useCache: false,
      },
    }, { request: ctx.request, correlationId: ctx.correlationId, timeoutMs: 120_000 });
    if (outcome.outcome === 'refusal') {
      throw new AppError('bounds', 'the federated engine refused the read', { code: 'warehouse.read_refused', details: { reason: outcome.refusal.code } });
    }
    const result = outcome.result;
    const objects = await allObjects(deps, ctx, result.queryId, result.page.objects, result.total);
    const sources = result.lineage.flatMap((l) => l.sources);
    const connectionIds = [...new Set(sources.map((s) => s.connectionId))].sort();
    const connectorVersions = [...new Set(sources.map((s) => s.connectorVersion))].sort();
    const sourceCount = new Map(result.lineage.map((l) => [l.propertyApiName, new Set(l.sources.map((s) => s.connectionId)).size]));
    const observedAt = new Date().toISOString();

    const columns: Column[] = [
      ID_COLUMN, ...properties.flatMap((p) => propertyColumns(columnOf.get(p.apiName)!, p.type)), ...LINEAGE_COLUMNS, HASHES_COLUMN, FIRST_OBSERVED_COLUMN,
    ];
    for (let i = 0; i < objects.length; i += deps.config.batchRows) {
      const batch = objects.slice(i, i + deps.config.batchRows);
      const read = await deps.bigQuery.run(ref, readCurrent(ref, table.tableName, properties.map((p) => columnOf.get(p.apiName)!),
        batch.map((o) => o.id)), options);
      bytesScanned += read.bytesProcessed;
      const previous = new Map(read.rows.map((r) => [String(r[ID_COLUMN.name]), r]));
      const rows: Record<string, unknown>[] = [];
      const history: Record<string, unknown>[] = [];
      for (const object of batch) {
        const row = rowOf(object, properties, columnOf, sourceCount);
        const before = previous.get(object.id);
        const beforeHashes = before === undefined ? undefined : parseHashes(before[HASHES_COLUMN.name]);
        for (const p of properties) {
          if (beforeHashes === undefined || beforeHashes[p.apiName] === row.hashes[p.apiName]) continue;
          const column = columnOf.get(p.apiName)!;
          history.push({
            silo_object_id: object.id, property: p.apiName, previous_value: before?.[column] ?? null,
            new_value: row.newValues[p.apiName] === null ? null : JSON.stringify(row.newValues[p.apiName]), observed_at: observedAt,
            connection_ids: connectionIds, _ontology_version: manifest.version.id,
          });
        }
        rows.push({
          ...row.columns, _connection_ids: connectionIds, _connector_versions: connectorVersions, _ontology_version: manifest.version.id,
          _observed_at: observedAt, [HASHES_COLUMN.name]: JSON.stringify(row.hashes), [FIRST_OBSERVED_COLUMN.name]: observedAt,
        });
      }
      const merged = await deps.bigQuery.run(ref, mergeCurrent(ref, table.tableName, columns, rows), options);
      bytesScanned += merged.bytesProcessed;
      if (history.length > 0) {
        const written = await deps.bigQuery.run(ref, insertHistory(ref, historyTableOf(table.tableName), history), options);
        bytesScanned += written.bytesProcessed;
      }
      rowsWritten += rows.length;
    }
    // The link tables from this type, written whole from the links the engine answers (69.14).
    rowsWritten += await syncLinks(deps, ctx, project, manifest, nomination.objectTypeId, observedAt);
    const counted = await deps.bigQuery.run(ref, countRows(ref, table.tableName), options);
    bytesScanned += counted.bytesProcessed;
    const rowCount = Number(counted.rows[0]?.['n'] ?? 0);

    await inTransaction(pool, ctx.request, async (db) => {
      await warehouseSyncRunRepo.update(db, runId, {
        status: 'completed', rowsWritten: String(rowsWritten), bytesScanned: String(bytesScanned), completedAt: new Date().toISOString(),
      });
      await warehouseTableRepo.update(db, table.id, { lastSyncedAt: observedAt, rowCount: String(rowCount) });
      if (mode === 'backfill' && await allCurrentSynced(db, project.id) && await warehouseProjectRepo.activateIfBackfilling(db, project.id)) {
        await recordEvent(db, ctx.request, ctx.correlationId, {
          event: 'warehouse_backfill_completed', resource: { type: 'warehouse', id: project.id }, detail: { rows: rowsWritten },
        });
      }
    });
  } catch (error) {
    // The failing stage, and for a refusal the engine's own code: codes only, never a value.
    const refusal = isAppError(error) && typeof error.details['reason'] === 'string' ? `:${error.details['reason']}` : '';
    const stage = isAppError(error) ? `${error.code}${refusal}` : 'warehouse.sync_failed';
    await inTransaction(pool, ctx.request, async (db) => {
      await warehouseSyncRunRepo.update(db, runId, {
        status: 'failed', error: stage.slice(0, 200), rowsWritten: String(rowsWritten), bytesScanned: String(bytesScanned),
        completedAt: new Date().toISOString(),
      });
      await recordEvent(db, ctx.request, ctx.correlationId, {
        event: 'warehouse_sync_failed', resource: { type: 'warehouse', id: project.id }, detail: { mode, stage },
      });
    });
    deps.logger.failure('a Warehouse table did not sync; it reads as stale', error, { event: 'warehouse.sync_failed', organisationId: project.organisationId });
  }
}

export function parseHashes(value: unknown): Record<string, string> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    // Stored as JSON; read back through to_json_string, which may quote it once more.
    const object = typeof parsed === 'string' ? JSON.parse(parsed) as unknown : parsed;
    return typeof object === 'object' && object !== null ? object as Record<string, string> : {};
  } catch {
    return {};
  }
}

/**
 * Each link table whose link type starts at this type and whose other end is nominated: its
 * rows replaced by the links the engine answers now (a link removed at the source leaves it).
 */
async function syncLinks(deps: WarehouseDeps, ctx: Context, project: WarehouseProject, manifest: Awaited<ReturnType<typeof readManifest>>,
  fromTypeId: string, observedAt: string): Promise<number> {
  const pool = deps.databases.pool('control');
  const tables = await inTransaction(pool, ctx.request, (db) => warehouseTableRepo.listForProject(db, project.id), { readOnly: true });
  const ref: DatasetRef = datasetOf(project);
  const options = { labels: { organisation: project.organisationId, service: 'warehouse-sync', purpose: 'warehouse_sync' as const } };
  let written = 0;
  for (const t of tables.filter((x) => x.kind === 'link' && x.droppedAt === null && x.linkTypeId !== null)) {
    const link = manifest.linkTypes.find((l) => l.id === t.linkTypeId && l.status === 'active' && l.fromTypeId === fromTypeId);
    const routeId = link?.defaultRouteId ?? link?.routes[0]?.id;
    if (link === undefined || routeId === undefined) continue;
    const outcome = await deps.services.call(runPlan, {
      body: {
        plan: {
          schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: manifest.version.id,
          nodes: [{ objectTypeId: link.fromTypeId, filters: [] }, { objectTypeId: link.toTypeId, filters: [] }],
          hops: [{ from: 0, to: 1, linkTypeId: link.id, routeId }], select: [], sort: [],
        },
        parameters: {}, trigger: 'structured', useCache: false,
      },
    }, { request: ctx.request, correlationId: ctx.correlationId, timeoutMs: 120_000 });
    if (outcome.outcome === 'refusal') {
      throw new AppError('bounds', 'the federated engine refused the links\' read', { code: 'warehouse.links_refused', details: { reason: outcome.refusal.code } });
    }
    const objects = await allObjects(deps, ctx, outcome.result.queryId, outcome.result.page.objects, outcome.result.total);
    const sources = outcome.result.lineage.flatMap((l) => l.sources);
    const lineage = {
      _connection_ids: [...new Set(sources.map((s) => s.connectionId))].sort(), _connector_versions: [...new Set(sources.map((s) => s.connectorVersion))].sort(),
      _ontology_version: manifest.version.id, _observed_at: observedAt,
    };
    const rows = objects.flatMap((o) => (o.links['0'] ?? o.links[0] ?? []).map((to: { id: string }) => ({ from_object_id: o.id, to_object_id: to.id, ...lineage })));
    await deps.bigQuery.run(ref, truncateTable(ref, t.tableName), options);
    for (let i = 0; i < rows.length; i += deps.config.batchRows) {
      await deps.bigQuery.run(ref, insertLinks(ref, t.tableName, rows.slice(i, i + deps.config.batchRows)), options);
    }
    await inTransaction(pool, ctx.request, (db) => warehouseTableRepo.update(db, t.id, { lastSyncedAt: observedAt, rowCount: String(rows.length) }));
    written += rows.length;
  }
  return written;
}

function rowOf(object: ResultObject, properties: readonly NominatedProperty[], columnOf: Map<string, string>, sourceCount: Map<string, number>) {
  const columns: Record<string, unknown> = { [ID_COLUMN.name]: object.id };
  const hashes: Record<string, string> = {};
  const newValues: Record<string, unknown> = {};
  for (const p of properties) {
    const column = columnOf.get(p.apiName)!;
    const disputed = object.disputed.includes(p.apiName);
    const withheld = object.masked.includes(p.apiName) || object.redacted.includes(p.apiName);
    const value = disputed || withheld ? null : (object.values[p.apiName] ?? null);
    columns[column] = bind(value, p.type);
    columns[`${column}__disputed`] = disputed;
    columns[`${column}__sources`] = disputed ? (sourceCount.get(p.apiName) ?? null) : null;
    hashes[p.apiName] = hashOf(value, disputed);
    newValues[p.apiName] = value;
  }
  return { columns, hashes, newValues };
}

async function allCurrentSynced(db: Parameters<typeof warehouseTableRepo.listForProject>[0], projectId: string): Promise<boolean> {
  const tables = await warehouseTableRepo.listForProject(db, projectId);
  return tables.filter((t) => t.kind === 'current').every((t) => t.lastSyncedAt !== null);
}
