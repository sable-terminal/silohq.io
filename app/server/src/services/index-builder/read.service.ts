// The Object Index as a planner source (spec 69.6; decision 2026-11-14). Two questions:
//
// - Coverage: for each object type, the properties a refreshed live nomination holds and
//   when it was last refreshed (its watermark). Metadata only; the planner's chooser decides.
// - Read: the entries of one type matching the planner's filters, among a split plan's keys
//   where given, with the selected properties. Answered only where search would answer
//   (search.service.ts): Siloes on; a refreshed nomination holding every property used; the
//   reader sees the type and every property used in full (a masked or redacted property is
//   never read from the index); the reader's grants reach every connection the entries came
//   from; and, per entry, every marking it carries (the object's and each column read's) is
//   one the reader satisfies. Otherwise it says why, and the planner goes to the sources.
//   Disputes as the engine treats them: each value comes back with its state, and an entry
//   whose first unmet filter is disputed is left out and counted. A type several systems
//   feed is answered only from a refresh that recorded states.
// Every answer states its refresh time: none is live.

import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { NOT_INDEXED_REASONS } from '../../contracts/index-builder/index.contract.ts';
import { VALUE_STATES, type ValueState } from '../../contracts/resolution/resolve.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { IndexDefinition, Silo } from '../../models/siloes/index.model.ts';
import { indexDefinitionRepo, siloRepo } from '../../repos/siloes/index.repo.ts';
import { selectEntries, stateColumnOf, type EntryFilter, type EntryOp } from '../warehouse-schema/generator/index.generator.ts';
import { nominatedProperties } from '../warehouse-schema/schema.service.ts';
import { columnFor, existingColumns, readManifest } from '../warehouse-schema/warehouse.service.ts';
import { siloesEnabled } from '../siloes-capture/deps.service.ts';
import { datasetRef, indexTableOf, type Context, type IndexDeps } from './index.service.ts';
import { markingsOf, refreshOptions } from './refresh.service.ts';

type Reason = (typeof NOT_INDEXED_REASONS)[number];

export interface IndexCoverage { objectTypeId: string; held: string[]; refreshedAt: string }

/** Each type's refreshed live nomination: the properties held (identity ids) and its watermark. */
export async function indexCoverage(deps: IndexDeps, ctx: Context, objectTypeIds: readonly string[]): Promise<{ types: IndexCoverage[] }> {
  const pool = deps.databases.pool('control');
  const on = await inTransaction(pool, ctx.request, (db) => siloesEnabled(db, ctx.request.organisationId!), { readOnly: true });
  if (!on) return { types: [] };
  const manifest = await readManifest(deps, ctx);
  const definitions = await inTransaction(pool, ctx.request, (db) => indexDefinitionRepo.liveForTypes(db, [...objectTypeIds]), { readOnly: true });
  const types: IndexCoverage[] = [];
  for (const typeId of new Set(objectTypeIds)) {
    const type = manifest.objectTypes.find((t) => t.id === typeId && t.status === 'active');
    // The freshest refreshed nomination of the type.
    const refreshed = definitions.filter((d) => d.objectTypeId === typeId && d.lastRefreshedAt !== null)
      .sort((a, b) => Date.parse(b.lastRefreshedAt!) - Date.parse(a.lastRefreshedAt!))[0];
    if (type === undefined || refreshed === undefined) continue;
    const held = type.properties.filter((p) => refreshed.nominatedProperties.includes(p.apiName)).map((p) => p.identityId);
    types.push({ objectTypeId: typeId, held, refreshedAt: refreshed.lastRefreshedAt! });
  }
  return { types };
}

export type IndexRead =
  | { outcome: 'read'; refreshedAt: string; exact: boolean; excludedByDispute: number;
    rows: { objectId: string; values: Record<string, unknown>; states: Record<string, ValueState> }[] }
  | { outcome: 'not_indexed'; reason: Reason };

export async function readIndex(deps: IndexDeps, ctx: Context, input: {
  objectTypeId: string; properties: string[]; filters: { property: string; op: EntryOp; value?: unknown }[]; keys?: string[] | undefined; limit: number;
}): Promise<IndexRead> {
  const pool = deps.databases.pool('control');
  const on = await inTransaction(pool, ctx.request, (db) => siloesEnabled(db, ctx.request.organisationId!), { readOnly: true });
  if (!on) return { outcome: 'not_indexed', reason: 'not_indexed' };
  const manifest = await readManifest(deps, ctx);
  const type = manifest.objectTypes.find((t) => t.id === input.objectTypeId && t.status === 'active');
  if (type === undefined) return { outcome: 'not_indexed', reason: 'not_indexed' };
  const used = [...new Set([...input.properties, ...input.filters.map((f) => f.property)])];
  const apiOf = new Map(type.properties.map((p) => [p.identityId, p.apiName]));
  if (used.some((id) => !apiOf.has(id))) return { outcome: 'not_indexed', reason: 'not_indexed' };
  const usedApi = used.map((id) => apiOf.get(id)!);

  const found = await inTransaction(pool, ctx.request, async (db) => {
    const holding = (await indexDefinitionRepo.liveForTypes(db, [type.id]))
      .filter((d) => usedApi.every((name) => d.nominatedProperties.includes(name)));
    const refreshed = holding.filter((d) => d.lastRefreshedAt !== null)
      .sort((a, b) => Date.parse(b.lastRefreshedAt!) - Date.parse(a.lastRefreshedAt!))[0];
    if (refreshed === undefined) return { reason: (holding.length === 0 ? 'not_indexed' : 'not_refreshed') as Reason };
    const silo = (await siloRepo.findById(db, refreshed.siloId))!;
    return { definition: refreshed, silo, markings: await markingsOf(db, silo, manifest, type.id, nominatedProperties(manifest, type.id, usedApi)) };
  }, { readOnly: true }) as { reason: Reason } | { definition: IndexDefinition; silo: Silo; markings: { object: string[]; byProperty: Map<string, string[]> } };
  if ('reason' in found) return { outcome: 'not_indexed', reason: found.reason };

  // The gates, for this reader, in one decision.
  const connections = [...new Set(type.contributingObjects.map((c) => c.connectionId))];
  const markingIds = [...new Set([...found.markings.object, ...[...found.markings.byProperty.values()].flat()])];
  const access = await deps.services.call(resolveAccess, {
    body: { objectTypes: [type.id], properties: used, connections: connections.slice(0, 500), markings: markingIds.slice(0, 500) },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  const typeVisible = access.objectTypes.some((t) => t.id === type.id && t.visible);
  const inFull = used.every((id) => access.properties.some((p) => p.id === id && p.visible && p.effect === 'allow'));
  if (access.decision !== 'allow' || !typeVisible || !inFull) return { outcome: 'not_indexed', reason: 'withheld' };
  if (connections.some((id) => (access.connections.find((c) => c.id === id)?.access ?? 'none') === 'none')) return { outcome: 'not_indexed', reason: 'no_access' };
  const satisfied = access.markings.filter((m) => m.satisfied).map((m) => m.id);

  const ref = datasetRef(deps, found.silo);
  const tableName = indexTableOf(found.definition.id);
  const existing = existingColumns(await deps.bigQuery.getTable({ ...ref, table: tableName }));
  const typed = new Map(nominatedProperties(manifest, type.id, usedApi).map((p) => [p.apiName, p.type]));
  const columnOf = (name: string) => columnFor(existing, name, typed.get(name)!);
  const select = input.properties.map((id) => columnOf(apiOf.get(id)!).name);
  // Which columns record states: all of them since the refresh that began recording them.
  const usedColumns = usedApi.map((n) => columnOf(n).name);
  const stated = usedColumns.filter((c) => existing.has(stateColumnOf(c)));
  if (stated.length < usedColumns.length && type.contributingObjects.length !== 1) return { outcome: 'not_indexed', reason: 'not_refreshed' };
  const filters: EntryFilter[] = input.filters.map((f) => {
    const name = apiOf.get(f.property)!;
    return { column: columnOf(name).name, type: typed.get(name)!, op: f.op, value: f.value };
  });
  const out = await deps.bigQuery.run(ref, selectEntries(ref, tableName, {
    select, filters, keys: input.keys ?? null, satisfied, limit: input.limit + 1, stated,
  }), refreshOptions(found.silo, 'index_read'));
  const kept = out.rows.slice(0, input.limit);
  const rows = kept.filter((r) => r['_excluded'] !== true).map((r) => ({
    objectId: String(r['_object_ref']),
    values: Object.fromEntries(input.properties.map((id, i) => {
      const raw = r[select[i]!];
      return [apiOf.get(id)!, typeof raw === 'string' ? JSON.parse(raw) as unknown : raw ?? null];
    })),
    states: Object.fromEntries(input.properties.flatMap((id, i) => {
      const state = r[stateColumnOf(select[i]!)];
      return typeof state === 'string' && (VALUE_STATES as readonly string[]).includes(state) ? [[apiOf.get(id)!, state as ValueState]] : [];
    })),
  }));
  return {
    outcome: 'read', refreshedAt: found.definition.lastRefreshedAt!, exact: out.rows.length <= input.limit,
    excludedByDispute: kept.length - rows.length, rows,
  };
}
