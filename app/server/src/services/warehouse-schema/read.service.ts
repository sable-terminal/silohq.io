// The Warehouse as a planner source (spec 69.6; decision 2026-11-14): history, time ranges
// and point-in-time ("as of") questions, and properties held only in Siloes.
//
// - Coverage: for each object type the active Warehouse holds, the properties nominated, its
//   watermark (the current table's last sync) and the history it holds (from when its history
//   table began). Metadata only.
// - As of: the objects first observed by the instant, each property as it stood then: the
//   previous value of its first change after the instant, else its current value (a value
//   unchanged since). A value the history cannot tell apart from empty is empty; a current
//   dispute shows only where nothing changed since. The filters apply to those values, in
//   the engine, over a bounded read: the answer is whole or refused.
// - Aggregate: a large aggregate over current state, computed in BigQuery with the engine's
//   rules for disputes (aggregateCurrent), so it means what the live answer would; the
//   answer is as of the watermark, which it states.
// Answered only where the reader sees the type and every property used in full, their grants
// reach the type's connections, and they satisfy every marking on what the Warehouse holds of
// the type (its own, the type's, the properties' and the connections').

import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { DataType, ObjectTypeView, OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { WarehouseProject } from '../../models/siloes/warehouseProject.model.ts';
import type { WarehouseTable } from '../../models/siloes/warehouseTable.model.ts';
import { siloObjectTypeRepo, warehouseProjectRepo, warehouseTableRepo } from '../../repos/siloes/index.repo.ts';
import { compareTyped } from '../executor/values.service.ts';
import { aggregateCurrent, changesAfter, changesBetween, readAsOfCurrent, type AggregateFn } from './generator/warehouse.generator.ts';
import { nominatedProperties } from './schema.service.ts';
import { columnFor, datasetOf, existingColumns, historyTableOf, readManifest, type Context, type WarehouseDeps } from './warehouse.service.ts';

export type AsOfOp = 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'is_null' | 'not_null';
export type DeclineReason = 'not_held' | 'withheld' | 'no_access' | 'before_history' | 'bounded';

interface Held { project: WarehouseProject; current: WarehouseTable; history: WarehouseTable; properties: string[] }

/** The organisation's active Warehouse's tables for a type, with its nominated properties (API names). */
async function heldFor(db: Queryable, organisationId: string, objectTypeId: string): Promise<Held | undefined> {
  const project = await warehouseProjectRepo.findByOrganisationId(db, organisationId);
  if (project === undefined || project.status !== 'active') return undefined;
  const nomination = await siloObjectTypeRepo.findLive(db, project.siloId, objectTypeId);
  if (nomination === undefined) return undefined;
  const tables = await warehouseTableRepo.listForProject(db, project.id);
  const current = tables.find((t) => t.kind === 'current' && t.objectTypeId === objectTypeId && t.droppedAt === null);
  const history = tables.find((t) => t.kind === 'history' && t.objectTypeId === objectTypeId && t.droppedAt === null);
  if (current === undefined || history === undefined || current.lastSyncedAt === null) return undefined;
  return { project, current, history, properties: nomination.nominatedProperties };
}

export interface WarehouseCoverage { objectTypeId: string; held: string[]; watermark: string; historyFrom: string; rowCount: number }

export async function warehouseCoverage(deps: WarehouseDeps, ctx: Context, objectTypeIds: readonly string[], linkTypeIds: readonly string[] = [])
  : Promise<{ types: WarehouseCoverage[]; links?: { linkTypeId: string; watermark: string }[] }> {
  const manifest = await readManifest(deps, ctx);
  const types: WarehouseCoverage[] = [];
  const links: { linkTypeId: string; watermark: string }[] = [];
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    if (linkTypeIds.length > 0) {
      const project = await warehouseProjectRepo.findByOrganisationId(db, ctx.request.organisationId!);
      const tables = project === undefined || project.status !== 'active' ? [] : await warehouseTableRepo.listForProject(db, project.id);
      for (const id of new Set(linkTypeIds)) {
        const t = tables.find((x) => x.kind === 'link' && x.linkTypeId === id && x.droppedAt === null);
        // A link table is written with its from type's sync: as fresh as that.
        const from = manifest.linkTypes.find((l) => l.id === id)?.fromTypeId;
        const fromTable = tables.find((x) => x.kind === 'current' && x.objectTypeId === from && x.droppedAt === null);
        const at = t?.lastSyncedAt ?? fromTable?.lastSyncedAt ?? null;
        if (t !== undefined && at !== null) links.push({ linkTypeId: id, watermark: at });
      }
    }
    for (const typeId of new Set(objectTypeIds)) {
      const type = manifest.objectTypes.find((t) => t.id === typeId && t.status === 'active');
      const held = type === undefined ? undefined : await heldFor(db, ctx.request.organisationId!, typeId);
      if (type === undefined || held === undefined) continue;
      types.push({
        objectTypeId: typeId, held: type.properties.filter((p) => held.properties.includes(p.apiName)).map((p) => p.identityId),
        watermark: held.current.lastSyncedAt!, historyFrom: held.history.createdAt, rowCount: Number(held.current.rowCount),
      });
    }
  }, { readOnly: true });
  return { types, ...(linkTypeIds.length === 0 ? {} : { links }) };
}

export type AsOfRead =
  | { outcome: 'read'; asOf: string; watermark: string; rows: { objectId: string; values: Record<string, unknown>; disputed: string[] }[] }
  | { outcome: 'declined'; reason: DeclineReason };

const parse = (raw: unknown): unknown => (typeof raw === 'string' ? JSON.parse(raw) as unknown : raw ?? null);

/** Whether a value meets a filter (pure; values compared as their data type). */
export function meets(value: unknown, op: AsOfOp, target: unknown, type: DataType): boolean {
  if (op === 'is_null') return value === null || value === undefined;
  if (op === 'not_null') return value !== null && value !== undefined;
  if (value === null || value === undefined) return false;
  if (op === 'in') return (target as unknown[]).some((t) => compareTyped(value as never, t as never, type as never) === 0);
  const c = compareTyped(value as never, target as never, type as never);
  return { eq: c === 0, neq: c !== 0, lt: c < 0, lte: c <= 0, gt: c > 0, gte: c >= 0 }[op];
}

interface Opened { held: Held; type: ObjectTypeView; manifest: OntologyManifest; byId: Map<string, ObjectTypeView['properties'][number]>; columnOf: Map<string, string> }

/**
 * The type as the Warehouse holds it, for this reader: every property used nominated, and the
 * gates passed in one decision (the type and each property visible in full, the connections
 * reached, every marking on what the Warehouse holds of the type satisfied). The column of
 * each property used, by API name.
 */
async function open(deps: WarehouseDeps, ctx: Context, objectTypeId: string, used: readonly string[]): Promise<Opened | DeclineReason> {
  const manifest = await readManifest(deps, ctx);
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId && t.status === 'active');
  if (type === undefined) return 'not_held';
  const byId = new Map(type.properties.map((p) => [p.identityId, p]));
  const loaded = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const held = await heldFor(db, ctx.request.organisationId!, type.id);
    return held === undefined ? undefined : { held, markings: await siloObjectTypeRepo.markingsOnHeld(db, held.project.siloId) };
  }, { readOnly: true });
  if (loaded === undefined || used.some((id) => !loaded.held.properties.includes(byId.get(id)?.apiName ?? ''))) return 'not_held';

  const connections = [...new Set(type.contributingObjects.map((c) => c.connectionId))];
  const markings = [...new Set(loaded.markings.filter((m) => m.objectTypeId === null || m.objectTypeId === type.id).map((m) => m.markingId))];
  const access = await deps.services.call(resolveAccess, {
    body: { objectTypes: [type.id], properties: [...used], connections: connections.slice(0, 500), markings: markings.slice(0, 500) },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  const visible = access.objectTypes.some((t) => t.id === type.id && t.visible)
    && used.every((id) => access.properties.some((p) => p.id === id && p.visible && p.effect === 'allow'));
  if (access.decision !== 'allow' || !visible || markings.some((m) => !access.markings.some((x) => x.id === m && x.satisfied))) return 'withheld';
  if (connections.some((id) => (access.connections.find((c) => c.id === id)?.access ?? 'none') === 'none')) return 'no_access';

  const existing = existingColumns(await deps.bigQuery.getTable({ ...datasetOf(loaded.held.project), table: loaded.held.current.tableName }));
  const typed = new Map(nominatedProperties(manifest, type.id, used.map((id) => byId.get(id)!.apiName)).map((p) => [p.apiName, p.type]));
  const columnOf = new Map(used.map((id) => {
    const apiName = byId.get(id)!.apiName;
    return [apiName, columnFor(existing, apiName, typed.get(apiName)!).name] as const;
  }));
  return { held: loaded.held, type, manifest, byId, columnOf };
}

const readOptions = (held: Held) => ({ labels: { organisation: held.project.organisationId, service: 'warehouse-schema', purpose: 'warehouse_read' as const } });

export async function readWarehouseAsOf(deps: WarehouseDeps, ctx: Context, input: {
  objectTypeId: string; properties: string[]; filters: { property: string; op: AsOfOp; value?: unknown }[]; asOf: string; limit: number;
}): Promise<AsOfRead> {
  const used = [...new Set([...input.properties, ...input.filters.map((f) => f.property)])];
  const opened = await open(deps, ctx, input.objectTypeId, used);
  if (typeof opened === 'string') return { outcome: 'declined', reason: opened };
  const { byId, columnOf, held } = opened;
  if (Date.parse(input.asOf) < Date.parse(held.history.createdAt)) return { outcome: 'declined', reason: 'before_history' };
  const ref = datasetOf(held.project);
  const options = readOptions(held);
  const current = await deps.bigQuery.run(ref, readAsOfCurrent(ref, held.current.tableName, [...columnOf.values()], input.asOf, input.limit + 1), options);
  if (current.rows.length > input.limit) return { outcome: 'declined', reason: 'bounded' };
  const ids = current.rows.map((r) => String(r['silo_object_id']));
  const later = ids.length === 0 ? { rows: [] as Record<string, unknown>[] }
    : await deps.bigQuery.run(ref, changesAfter(ref, historyTableOf(held.current.tableName), [...columnOf.keys()], input.asOf, ids), options);
  const before = new Map(later.rows.map((r) => [`${String(r['silo_object_id'])}\u0000${String(r['property'])}`, parse(r['previous_value'])]));

  const rows = current.rows.map((r) => {
    const objectId = String(r['silo_object_id']);
    const values: Record<string, unknown> = {};
    const disputed: string[] = [];
    for (const [apiName, column] of columnOf) {
      const k = `${objectId}\u0000${apiName}`;
      if (before.has(k)) values[apiName] = before.get(k);
      else {
        values[apiName] = parse(r[column]);
        if (r[`${column}__disputed`] === true) disputed.push(apiName);
      }
    }
    return { objectId, values, disputed };
  }).filter((row) => input.filters.every((f) => {
    const p = byId.get(f.property)!;
    return !row.disputed.includes(p.apiName) && meets(row.values[p.apiName], f.op, f.value, p.dataType);
  }));
  return { outcome: 'read', asOf: input.asOf, watermark: held.current.lastSyncedAt!, rows };
}

export type HistoryRead =
  | { outcome: 'read'; watermark: string; changes: { objectId: string; property: string; at: string; previous: unknown; value: unknown }[] }
  | { outcome: 'declined'; reason: DeclineReason };

/**
 * Every change in a half-open period to these properties of these objects (69.16), from the
 * history table, oldest first, by property API name. Declined where the Warehouse does not
 * hold them, the reader may not see them, its history starts after the period does, or the
 * changes pass the bound (never truncated).
 */
export async function readWarehouseHistory(deps: WarehouseDeps, ctx: Context, input: {
  objectTypeId: string; properties: string[]; from: string; to: string; objectIds: string[]; limit: number;
}): Promise<HistoryRead> {
  const opened = await open(deps, ctx, input.objectTypeId, input.properties);
  if (typeof opened === 'string') return { outcome: 'declined', reason: opened };
  const { columnOf, held } = opened;
  if (Date.parse(input.from) < Date.parse(held.history.createdAt)) return { outcome: 'declined', reason: 'before_history' };
  if (input.objectIds.length === 0) return { outcome: 'read', watermark: held.current.lastSyncedAt!, changes: [] };
  const ref = datasetOf(held.project);
  const out = await deps.bigQuery.run(ref, changesBetween(ref, historyTableOf(held.current.tableName), [...columnOf.keys()], input.from, input.to,
    input.objectIds, input.limit + 1), readOptions(held));
  if (out.rows.length > input.limit) return { outcome: 'declined', reason: 'bounded' };
  return {
    outcome: 'read', watermark: held.current.lastSyncedAt!,
    changes: out.rows.map((r) => ({
      objectId: String(r['silo_object_id']), property: String(r['property']), at: new Date(String(r['observed_at'])).toISOString(),
      previous: parse(r['previous_value']), value: parse(r['new_value']),
    })),
  };
}

export type AggregateRead =
  | {
    outcome: 'read'; watermark: string; population: number; excludedByDispute: number;
    groups: { key: Record<string, unknown>; objects: number; measures: Record<string, number | null>; excluded: Record<string, number> }[];
    /** By property identity id, over the population: values held and values disputed. */
    values: Record<string, number>; disputed: Record<string, number>;
  }
  | { outcome: 'declined'; reason: DeclineReason };

/** A min or max as the engine states it: a number, or a time as epoch milliseconds; nothing else has one. */
function extreme(raw: unknown, type: DataType): number | null {
  const v = parse(raw);
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  if (type === 'timestamp') return Date.parse(v);
  if (type === 'date') return Date.parse(`${v}T00:00:00Z`);
  return null;
}

export async function aggregateWarehouse(deps: WarehouseDeps, ctx: Context, input: {
  objectTypeId: string; groupBy: string[]; measures: { as: string; fn: AggregateFn; property?: string | undefined; node?: 0 | 1 | undefined }[];
  filters: { property: string; op: AsOfOp; value?: unknown }[]; limit: number;
  hop?: { linkTypeId: string; objectTypeId: string; reverse: boolean } | undefined;
}): Promise<AggregateRead> {
  const near = input.measures.filter((m) => (m.node ?? 0) === 0);
  const linked = input.measures.filter((m) => m.node === 1);
  if (linked.length > 0 && input.hop === undefined) return { outcome: 'declined', reason: 'not_held' };
  // The far side across the hop (D116): held, visible, and the link's table present.
  let across: { targetTable: string; linkTable: string; columnFor: (id: string) => string; byId: Map<string, { dataType: DataType }> } | undefined;
  if (input.hop !== undefined) {
    const target = await open(deps, ctx, input.hop.objectTypeId, [...new Set(linked.flatMap((m) => (m.property === undefined ? [] : [m.property])))]);
    if (typeof target === 'string') return { outcome: 'declined', reason: target };
    const linkTable = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => (await warehouseTableRepo.listForProject(db, target.held.project.id))
      .find((t) => t.kind === 'link' && t.linkTypeId === input.hop!.linkTypeId && t.droppedAt === null), { readOnly: true });
    if (linkTable === undefined) return { outcome: 'declined', reason: 'not_held' };
    across = {
      targetTable: target.held.current.tableName, linkTable: linkTable.tableName, byId: target.byId,
      columnFor: (id) => target.columnOf.get(target.byId.get(id)!.apiName)!,
    };
  }
  const measured = near.flatMap((m) => (m.property === undefined ? [] : [m.property]));
  const counted = [...new Set([...input.groupBy, ...measured])];
  const used = [...new Set([...counted, ...input.filters.map((f) => f.property)])];
  const opened = await open(deps, ctx, input.objectTypeId, used);
  if (typeof opened === 'string') return { outcome: 'declined', reason: opened };
  const { byId, columnOf, held } = opened;
  const columnFor = (id: string) => columnOf.get(byId.get(id)!.apiName)!;
  const typed = new Map(nominatedProperties(opened.manifest, opened.type.id, used.map((id) => byId.get(id)!.apiName)).map((p) => [p.apiName, p.type]));
  const ref = datasetOf(held.project);
  const out = await deps.bigQuery.run(ref, aggregateCurrent(ref, held.current.tableName, {
    groupBy: input.groupBy.map(columnFor),
    measures: near.map((m) => ({ fn: m.fn, column: m.property === undefined ? null : columnFor(m.property) })),
    filters: input.filters.map((f) => ({ column: columnFor(f.property), type: typed.get(byId.get(f.property)!.apiName)!, op: f.op, value: f.value })),
    counted: counted.map(columnFor),
    limit: input.limit + 3,
  }, across === undefined ? undefined : {
    linkTable: across.linkTable, targetTable: across.targetTable, reverse: input.hop!.reverse,
    measures: linked.map((m) => ({ fn: m.fn, column: m.property === undefined ? null : across!.columnFor(m.property) })),
  }), readOptions(held));
  if (out.rows.filter((r) => r['_state'] === 'ok').length > input.limit) return { outcome: 'declined', reason: 'bounded' };

  let population = 0;
  let excludedByDispute = 0;
  const values: Record<string, number> = {};
  const disputed: Record<string, number> = {};
  const groups: Extract<AggregateRead, { outcome: 'read' }>['groups'] = [];
  for (const row of out.rows) {
    const objects = Number(row['_rows'] ?? 0);
    if (row['_state'] === 'filter') { excludedByDispute += objects; continue; }
    population += objects;
    counted.forEach((id, i) => {
      values[id] = (values[id] ?? 0) + Number(row[`_v${i}`] ?? 0);
      disputed[id] = (disputed[id] ?? 0) + Number(row[`_w${i}`] ?? 0);
    });
    if (row['_state'] === 'key') { excludedByDispute += objects; continue; }
    const key = Object.fromEntries(input.groupBy.map((id, i) => [byId.get(id)!.apiName, parse(row[`_k${i}`])]));
    const measures: Record<string, number | null> = {};
    const excluded: Record<string, number> = {};
    // Across the hop: over each group's distinct linked objects; excluded counts those without a value.
    linked.forEach((m, i) => {
      if (m.property === undefined) { measures[m.as] = Number(row[`_l${i}`] ?? 0); excluded[m.as] = 0; return; }
      const all = Number(row[`_l${i}_all`] ?? 0);
      const n = Number(row[`_l${i}_n`] ?? 0);
      excluded[m.as] = all - n;
      const value = row[`_l${i}`];
      const type = across!.byId.get(m.property)!.dataType;
      measures[m.as] = m.fn === 'count' ? n : n === 0 ? null : m.fn === 'count_distinct' ? Number(value)
        : m.fn === 'sum' ? Number(parse(value)) : m.fn === 'avg' ? Number(parse(value)) / n : extreme(value, type);
    });
    near.forEach((m, i) => {
      if (m.property === undefined) { measures[m.as] = objects; excluded[m.as] = 0; return; }
      const n = Number(row[`_m${i}_n`] ?? 0);
      excluded[m.as] = objects - n;
      const value = row[`_m${i}`];
      const type = byId.get(m.property)!.dataType;
      measures[m.as] = m.fn === 'count' ? n : n === 0 ? null : m.fn === 'count_distinct' ? Number(value)
        : m.fn === 'sum' ? Number(parse(value)) : m.fn === 'avg' ? Number(parse(value)) / n : extreme(value, type);
    });
    groups.push({ key, objects, measures, excluded });
  }
  return { outcome: 'read', watermark: held.current.lastSyncedAt!, population, excludedByDispute, groups, values, disputed };
}
