// warehouse-schema (spec 69.14): the tables follow the ontology, not the source systems.
//
// For each nominated object type: <type> (current state) and <type>__history; for each link
// type whose both ends are nominated: link__<link_type>. An added property adds a column; a
// changed property type adds a versioned column (<name>__v2) rather than rewriting history;
// a removed property's column is kept (dropping it waits for the retention window). Every
// table and change is recorded in siloes.warehouse_tables and audited.
// The Action ledger table waits for the Action ledger to be enabled (spec 48).

import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import type { WarehouseTableView } from '../../contracts/warehouse/warehouse.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { WarehouseProject } from '../../models/siloes/index.model.ts';
import { siloObjectTypeRepo, warehouseProjectRepo, warehouseTableRepo } from '../../repos/siloes/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  addColumns, COLUMN_TYPE, createTable, FIRST_OBSERVED_COLUMN, HASHES_COLUMN, HISTORY_COLUMNS, ID_COLUMN, LINEAGE_COLUMNS, LINK_COLUMNS, propertyColumns,
  type Column, type ColumnType,
} from './generator/warehouse.generator.ts';
import {
  columnFor, datasetOf, existingColumns, historyTableOf, linkTableOf, readManifest, recordEvent, warehouseView, type Context,
  type WarehouseDeps,
} from './warehouse.service.ts';

export interface NominatedProperty {
  apiName: string;
  identityId: string;
  type: ColumnType;
}

/** The nominated properties of a type that the ontology still has, with their column types. */
export function nominatedProperties(manifest: OntologyManifest, objectTypeId: string, apiNames: readonly string[]): NominatedProperty[] {
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId);
  if (type === undefined) return [];
  const wanted = new Set(apiNames);
  return type.properties.filter((p) => wanted.has(p.apiName) && p.status === 'active')
    .map((p) => ({ apiName: p.apiName, identityId: p.identityId, type: COLUMN_TYPE[p.dataType] }));
}

const labels = (project: WarehouseProject) => ({ organisation: project.organisationId, service: 'warehouse-schema', purpose: 'warehouse_schema' as const });

export async function applySchema(deps: WarehouseDeps, ctx: Context, warehouseId: string)
  : Promise<{ ontologyVersionId: string; created: string[]; added: string[]; tables: WarehouseTableView[] }> {
  const pool = deps.databases.pool('control');
  const loaded = await inTransaction(pool, ctx.request, async (db) => {
    const project = await warehouseProjectRepo.findById(db, warehouseId);
    if (!project) throw new AppError('not_found', 'no such Warehouse', { code: 'warehouse.not_found' });
    return { project, nominations: await siloObjectTypeRepo.listLive(db, project.siloId) };
  }, { readOnly: true });
  const { project, nominations } = loaded;
  const manifest = await readManifest(deps, ctx);
  const ref = datasetOf(project);
  const options = { labels: labels(project) };
  const created: string[] = [];
  const added: string[] = [];
  const records: { name: string; kind: 'current' | 'history' | 'link'; objectTypeId: string | null; linkTypeId: string | null; retired?: string[] }[] = [];

  const ensure = async (name: string, columns: readonly Column[]): Promise<void> => {
    const info = await deps.bigQuery.getTable({ ...ref, table: name });
    if (info === undefined) {
      await deps.bigQuery.run(ref, createTable(ref, name, columns), options);
      created.push(name);
      return;
    }
    const existing = existingColumns(info);
    const missing = columns.filter((c) => !existing.has(c.name));
    if (missing.length > 0) {
      await deps.bigQuery.run(ref, addColumns(ref, name, missing), options);
      added.push(...missing.map((c) => `${name}.${c.name}`));
    }
  };

  for (const n of nominations) {
    const type = manifest.objectTypes.find((t) => t.id === n.objectTypeId && t.status === 'active');
    if (type === undefined) continue;
    const info = await deps.bigQuery.getTable({ ...ref, table: type.apiName });
    const existing = existingColumns(info);
    const valueColumns = nominatedProperties(manifest, type.id, n.nominatedProperties)
      .flatMap((p) => propertyColumns(columnFor(existing, p.apiName, p.type).name, p.type));
    const wanted = [ID_COLUMN, ...valueColumns, ...LINEAGE_COLUMNS, HASHES_COLUMN, FIRST_OBSERVED_COLUMN];
    await ensure(type.apiName, wanted);
    await ensure(historyTableOf(type.apiName), HISTORY_COLUMNS);
    // A column no nominated property lives in any more: kept, and dropped once the window has passed (69.14).
    const kept = new Set(wanted.map((c) => c.name));
    records.push({ name: type.apiName, kind: 'current', objectTypeId: type.id, linkTypeId: null, retired: [...existing.keys()].filter((c) => !kept.has(c)) });
    records.push({ name: historyTableOf(type.apiName), kind: 'history', objectTypeId: type.id, linkTypeId: null });
  }
  const nominated = new Set(nominations.map((n) => n.objectTypeId));
  for (const link of manifest.linkTypes) {
    if (link.status !== 'active' || !nominated.has(link.fromTypeId) || !nominated.has(link.toTypeId)) continue;
    await ensure(linkTableOf(link.apiName), LINK_COLUMNS);
    records.push({ name: linkTableOf(link.apiName), kind: 'link', objectTypeId: null, linkTypeId: link.id });
  }

  const versionId = manifest.version.id;
  const tables = await inTransaction(pool, ctx.request, async (db) => {
    for (const r of records) {
      const row = await warehouseTableRepo.findByWarehouseProjectIdAndTableName(db,
        { organisationId: project.organisationId, warehouseProjectId: project.id, tableName: r.name });
      if (row === undefined) {
        await warehouseTableRepo.insert(db, {
          id: uuidv7(), organisationId: project.organisationId, warehouseProjectId: project.id, objectTypeId: r.objectTypeId,
          linkTypeId: r.linkTypeId, tableName: r.name, kind: r.kind, ontologyVersionId: versionId,
        });
        await recordEvent(db, ctx.request, ctx.correlationId, {
          event: 'warehouse_table_created', resource: { type: 'warehouse', id: project.id }, detail: { kind: r.kind },
        });
      } else if (row.ontologyVersionId !== versionId) {
        await warehouseTableRepo.update(db, row.id, { ontologyVersionId: versionId });
      }
      if (r.retired !== undefined) {
        const before = (row?.retiredColumns ?? {}) as Record<string, string>;
        const now = new Date().toISOString();
        const retired = Object.fromEntries(r.retired.map((c) => [c, before[c] ?? now]));
        const current = row ?? await warehouseTableRepo.findByWarehouseProjectIdAndTableName(db,
          { organisationId: project.organisationId, warehouseProjectId: project.id, tableName: r.name });
        if (current !== undefined && JSON.stringify(retired) !== JSON.stringify(before)) await warehouseTableRepo.update(db, current.id, { retiredColumns: retired as never });
      }
    }
    if (added.length > 0) {
      await recordEvent(db, ctx.request, ctx.correlationId, {
        event: 'warehouse_schema_changed', resource: { type: 'warehouse', id: project.id }, detail: { columns_added: added.length },
      });
    }
    return (await warehouseView(db, project)).tables;
  });
  return { ontologyVersionId: versionId, created, added, tables };
}
