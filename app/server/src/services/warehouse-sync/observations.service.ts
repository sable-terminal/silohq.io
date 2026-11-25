// Incremental Warehouse writes (spec 69.15): see contracts/warehouse/observations.contract.ts.
// The latest observation of each property of each object wins; a value unchanged since the
// last write (by hash) writes nothing; a changed one updates its columns, the object's hashes
// and lineage, and adds a history row with the previous value as stored.

import type { WarehouseObservation } from '../../contracts/warehouse/observations.contract.ts';
import type { DatasetRef } from '../../infra/bigquery.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { siloObjectTypeRepo, warehouseProjectRepo, warehouseTableRepo } from '../../repos/siloes/index.repo.ts';
import {
  FIRST_OBSERVED_COLUMN, HASHES_COLUMN, ID_COLUMN, insertHistory, LINEAGE_COLUMNS, mergeCurrent, propertyColumns, readCurrent, type Column,
} from '../warehouse-schema/generator/warehouse.generator.ts';
import { nominatedProperties } from '../warehouse-schema/schema.service.ts';
import { asWarehouse, columnFor, datasetOf, existingColumns, historyTableOf, readManifest, type Context, type WarehouseDeps } from '../warehouse-schema/warehouse.service.ts';
import { bind, hashOf, parseHashes } from './sync.service.ts';

export async function applyObservations(deps: WarehouseDeps, ctx: Context, siloId: string, entries: readonly WarehouseObservation[])
  : Promise<{ applied: number; history: number; skipped: number }> {
  const pool = deps.databases.pool('control');
  const loaded = await inTransaction(pool, ctx.request, async (db) => {
    const project = await warehouseProjectRepo.findByOrganisationId(db, ctx.request.organisationId!);
    if (project === undefined || project.siloId !== siloId || project.status === 'handed_over' || project.status === 'purged') return undefined;
    return { project, nominations: await siloObjectTypeRepo.listLive(db, siloId), tables: await warehouseTableRepo.listForProject(db, project.id) };
  }, { readOnly: true });
  if (loaded === undefined) return { applied: 0, history: 0, skipped: entries.length };
  const { project, nominations, tables } = loaded;
  const principal = asWarehouse(project, ctx.correlationId);
  const manifest = await readManifest(deps, principal);
  const ref: DatasetRef = datasetOf(project);
  const options = { labels: { organisation: project.organisationId, service: 'warehouse-sync', purpose: 'warehouse_sync' as const } };
  let applied = 0;
  let history = 0;
  let skipped = 0;

  for (const typeId of [...new Set(entries.map((e) => e.objectTypeId))]) {
    const nomination = nominations.find((n) => n.objectTypeId === typeId);
    const table = tables.find((t) => t.kind === 'current' && t.objectTypeId === typeId);
    const type = manifest.objectTypes.find((t) => t.id === typeId);
    const ofType = entries.filter((e) => e.objectTypeId === typeId);
    if (nomination === undefined || table === undefined || type === undefined) { skipped += ofType.length; continue; }
    const properties = nominatedProperties(manifest, typeId, nomination.nominatedProperties);
    const existing = existingColumns(await deps.bigQuery.getTable({ ...ref, table: table.tableName }));
    const columnOf = new Map(properties.filter((p) => columnFor(existing, p.apiName, p.type).exists).map((p) => [p.apiName, columnFor(existing, p.apiName, p.type).name]));

    // The latest value of each property of each object.
    const latest = new Map<string, Map<string, WarehouseObservation>>();
    for (const e of ofType) {
      if (!columnOf.has(e.property)) { skipped += 1; continue; }
      const byProperty = latest.get(e.objectRef) ?? new Map<string, WarehouseObservation>();
      const prior = byProperty.get(e.property);
      if (prior === undefined || prior.observedAt <= e.observedAt) byProperty.set(e.property, e);
      latest.set(e.objectRef, byProperty);
    }
    if (latest.size === 0) continue;
    const read = await deps.bigQuery.run(ref, readCurrent(ref, table.tableName, [...columnOf.values()], [...latest.keys()]), options);
    const previous = new Map(read.rows.map((r) => [String(r[ID_COLUMN.name]), r]));
    const version = (connectionId: string) => type.contributingObjects.find((c) => c.connectionId === connectionId)?.connectorVersion;

    // One merge per set of changed properties: a merge writes the same columns for every row.
    const groups = new Map<string, { columns: Column[]; rows: Record<string, unknown>[] }>();
    const historyRows: Record<string, unknown>[] = [];
    for (const [objectRef, byProperty] of latest) {
      const before = previous.get(objectRef);
      const hashes = before === undefined ? {} : parseHashes(before[HASHES_COLUMN.name]);
      const changed = properties.filter((p) => byProperty.has(p.apiName) && hashes[p.apiName] !== hashOf(byProperty.get(p.apiName)!.value, false));
      if (changed.length === 0) continue;
      const row: Record<string, unknown> = { [ID_COLUMN.name]: objectRef };
      const connections = [...new Set(changed.map((p) => byProperty.get(p.apiName)!.connectionId))].sort();
      const observedAt = changed.map((p) => byProperty.get(p.apiName)!.observedAt).sort().at(-1)!;
      for (const p of changed) {
        const o = byProperty.get(p.apiName)!;
        const column = columnOf.get(p.apiName)!;
        row[column] = bind(o.value, p.type);
        row[`${column}__disputed`] = false;
        row[`${column}__sources`] = null;
        hashes[p.apiName] = hashOf(o.value, false);
        if (before !== undefined) {
          historyRows.push({
            silo_object_id: objectRef, property: p.apiName, previous_value: before[column] ?? null,
            new_value: o.value === null ? null : JSON.stringify(o.value), observed_at: o.observedAt, connection_ids: [o.connectionId],
            _ontology_version: manifest.version.id,
          });
        }
      }
      Object.assign(row, {
        _connection_ids: connections, _connector_versions: [...new Set(connections.map(version).filter((v): v is string => v !== undefined))].sort(),
        _ontology_version: manifest.version.id, _observed_at: observedAt, [HASHES_COLUMN.name]: JSON.stringify(hashes),
        [FIRST_OBSERVED_COLUMN.name]: observedAt,
      });
      const signature = changed.map((p) => p.apiName).sort().join(',');
      const group = groups.get(signature) ?? {
        columns: [ID_COLUMN, ...changed.flatMap((p) => propertyColumns(columnOf.get(p.apiName)!, p.type)), ...LINEAGE_COLUMNS, HASHES_COLUMN,
          FIRST_OBSERVED_COLUMN], rows: [],
      };
      group.rows.push(row);
      groups.set(signature, group);
      applied += 1;
    }
    for (const group of groups.values()) await deps.bigQuery.run(ref, mergeCurrent(ref, table.tableName, group.columns, group.rows), options);
    if (historyRows.length > 0) await deps.bigQuery.run(ref, insertHistory(ref, historyTableOf(table.tableName), historyRows), options);
    history += historyRows.length;
  }
  return { applied, history, skipped };
}
