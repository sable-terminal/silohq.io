// Object Index refresh (spec 69.4): a scheduled bounded query per nominated type, as the
// Silo's own principal, through the federated engine (whose bounds and per-connection rate
// limits keep each source within its declared limits). Not metered as tokens.
//
//   query → nominated properties only → markings attached → written in batches → entries
//   not observed removed → refresh state recorded
//
// - Only nominated properties are read and held (69.2), each with its state as the engine
//   decided it (<property>__state), so a read treats it as the engine does. A disputed value
//   is held as null: the index never holds a value the ontology would refuse to return; a
//   value the principal may only see masked or redacted is not held at all (unchecked).
// - Markings (69.5): each entry carries the object's markings (its type's, its connections'
//   and the Silo's) and each property's own, as they stand at the refresh. Search filters on
//   them for every reader.
// - A changed entry is rewritten, an unchanged one only re-stamped; an entry the refresh did
//   not observe was removed at its source and leaves the index.
// - Every run is a siloes.index_refreshes row; a failure names its stage, never a value.
// Change-stream refresh (69.4: the queue Capture uses) comes with siloes-capture.

import { createHash } from 'node:crypto';
import { runPlan, type ResultObject } from '../../contracts/executor/result.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { PLAN_SCHEMA_VERSION } from '../../contracts/planner/plan.contract.ts';
import type { QueryOptions } from '../../infra/bigquery.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { IndexDefinition, Silo } from '../../models/siloes/index.model.ts';
import { resourceMarkingRepo } from '../../repos/gov/index.repo.ts';
import { objectTypeMarkingRepo } from '../../repos/iam/index.repo.ts';
import { indexDefinitionRepo, indexRefreshRepo } from '../../repos/siloes/index.repo.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  createIndexTable, dropColumns, dropTable, INDEX_HEAD_COLUMNS, INDEX_KEY, INDEX_TAIL_COLUMNS, indexPropertyColumns, markingColumnOf, mergeEntries, stateColumnOf,
  readHashes, removeUnobserved,
} from '../warehouse-schema/generator/index.generator.ts';
import { addColumns, type Column } from '../warehouse-schema/generator/warehouse.generator.ts';
import { nominatedProperties, type NominatedProperty } from '../warehouse-schema/schema.service.ts';
import { columnFor, existingColumns, readManifest, recordEvent } from '../warehouse-schema/warehouse.service.ts';
import { allObjects, bind } from '../warehouse-sync/sync.service.ts';
import {
  asIndex, datasetLabels, datasetRef, indexTableOf, isUniqueViolation, loadIndexSilo, nextRefreshAt, TIME_TRAVEL_HOURS, type Context, type IndexDeps,
} from './index.service.ts';

export type RefreshTrigger = 'schedule' | 'change_stream' | 'rebuild';

const SYSTEM = new Set([...INDEX_HEAD_COLUMNS, ...INDEX_TAIL_COLUMNS].map((c) => c.name));

export const refreshOptions = (silo: Pick<Silo, 'id' | 'organisationId'>, purpose: 'index_refresh' | 'index_search' | 'index_read' = 'index_refresh'): QueryOptions => ({
  labels: { organisation: silo.organisationId, service: 'index-builder', purpose, silo: silo.id },
});

/** The markings an entry carries: the object's (type, connections, Silo) and each property's. */
export async function markingsOf(db: Queryable, silo: Pick<Silo, 'id'>, manifest: OntologyManifest, objectTypeId: string,
  properties: readonly NominatedProperty[]): Promise<{ object: string[]; byProperty: Map<string, string[]> }> {
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId);
  const connections = [...new Set((type?.contributingObjects ?? []).map((c) => c.connectionId))];
  const object = new Set<string>();
  for (const m of await objectTypeMarkingRepo.markingsFor(db, [objectTypeId])) object.add(m.markingId);
  for (const m of await resourceMarkingRepo.markingsFor(db, 'connection', connections)) object.add(m.markingId);
  for (const m of await resourceMarkingRepo.markingsFor(db, 'silo', [silo.id])) object.add(m.markingId);
  const byIdentity = new Map<string, string[]>();
  for (const m of await resourceMarkingRepo.markingsFor(db, 'property', properties.map((p) => p.identityId))) {
    byIdentity.set(m.resourceId, [...(byIdentity.get(m.resourceId) ?? []), m.markingId]);
  }
  return {
    object: [...object].sort(),
    byProperty: new Map(properties.map((p) => [p.apiName, [...new Set(byIdentity.get(p.identityId) ?? [])].sort()])),
  };
}

/** Starts a refresh detached; a definition already refreshing is left to that run. */
export async function startRefresh(deps: IndexDeps, definition: Pick<IndexDefinition, 'id' | 'organisationId'>, trigger: RefreshTrigger,
  correlationId: string): Promise<string | undefined> {
  const pool = deps.databases.pool('control');
  const scope = { organisationId: definition.organisationId };
  const { silo, row } = await inTransaction(pool, scope, async (db) => {
    const row = (await indexDefinitionRepo.findById(db, definition.id))!;
    return { silo: await loadIndexSilo(db, row.siloId), row };
  }, { readOnly: true });
  const ctx = asIndex(silo, correlationId);
  const refreshId = uuidv7();
  try {
    await inTransaction(pool, ctx.request, (db) => indexRefreshRepo.insert(db, {
      id: refreshId, organisationId: silo.organisationId, indexDefinitionId: row.id, trigger,
    }));
  } catch (error) {
    // One running refresh per definition (index_refreshes_one_running).
    if (isUniqueViolation(error)) return undefined;
    throw error;
  }
  void refresh(deps, ctx, silo, row, refreshId, trigger).catch((error: unknown) => {
    deps.logger.failure('an Object Index refresh failed outside its record', error, { event: 'index.refresh_crashed', organisationId: silo.organisationId });
  });
  return refreshId;
}

async function refresh(deps: IndexDeps, ctx: Context, silo: Silo, definition: IndexDefinition, refreshId: string, trigger: RefreshTrigger): Promise<void> {
  const pool = deps.databases.pool('control');
  const ref = datasetRef(deps, silo);
  const tableName = indexTableOf(definition.id);
  const options = refreshOptions(silo);
  let written = 0;
  let removed = 0;
  const startedAt = new Date().toISOString();
  try {
    const manifest = await readManifest(deps, ctx);
    const properties = nominatedProperties(manifest, definition.objectTypeId, definition.nominatedProperties);
    if (properties.length === 0) throw new AppError('validation', 'no nominated property is left in the ontology', { code: 'index.nothing_nominated' });
    const markings = await inTransaction(pool, ctx.request, (db) => markingsOf(db, silo, manifest, definition.objectTypeId, properties), { readOnly: true });

    // The table, level with the nomination: added properties add columns, a changed type a
    // versioned column, removed properties drop theirs and their values with them.
    // A purge while this refresh runs (70.2) ends it: nothing is written after the purge, and
    // what it wrote before noticing goes with it.
    const stillLive = async (): Promise<void> => {
      const current = await inTransaction(pool, ctx.request, (db) => indexDefinitionRepo.findById(db, definition.id), { readOnly: true });
      if (current === undefined || current.removedAt !== null) throw new AppError('conflict', 'the index was purged while it refreshed', { code: 'index.purged' });
    };
    await stillLive();
    await deps.bigQuery.ensureDataset(ref, { maxTimeTravelHours: TIME_TRAVEL_HOURS, labels: datasetLabels(silo) });
    if (trigger === 'rebuild') await deps.bigQuery.run(ref, dropTable(ref, tableName), options);
    const info = await deps.bigQuery.getTable({ ...ref, table: tableName });
    const existing = existingColumns(info);
    const columnOf = new Map(properties.map((p) => [p.apiName, columnFor(existing, p.apiName, p.type).name]));
    const columns: Column[] = [
      ...INDEX_HEAD_COLUMNS, ...properties.flatMap((p) => indexPropertyColumns(columnOf.get(p.apiName)!, p.type)), ...INDEX_TAIL_COLUMNS,
    ];
    if (info === undefined) {
      await deps.bigQuery.run(ref, createIndexTable(ref, tableName, columns), options);
    } else {
      const missing = columns.filter((c) => !existing.has(c.name));
      if (missing.length > 0) await deps.bigQuery.run(ref, addColumns(ref, tableName, missing), options);
      const kept = new Set(columns.map((c) => c.name));
      const stale = [...existing.keys()].filter((c) => !kept.has(c) && !SYSTEM.has(c));
      if (stale.length > 0) await deps.bigQuery.run(ref, dropColumns(ref, tableName, stale), options);
    }

    // The read: the whole type, nominated properties only.
    const outcome = await deps.services.call(runPlan, {
      body: {
        plan: {
          schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: manifest.version.id,
          nodes: [{ objectTypeId: definition.objectTypeId, filters: [] }], hops: [],
          select: properties.map((p) => ({ node: 0, property: p.identityId })), sort: [],
        },
        parameters: {}, trigger: 'structured', useCache: false,
      },
    }, { request: ctx.request, correlationId: ctx.correlationId, timeoutMs: 120_000 });
    if (outcome.outcome === 'refusal') {
      throw new AppError('bounds', 'the federated engine refused the read', { code: 'index.read_refused', details: { reason: outcome.refusal.code } });
    }
    const result = outcome.result;
    const objects = await allObjects(deps, ctx, result.queryId, result.page.objects, result.total);
    const sources = result.lineage.flatMap((l) => l.sources);
    const lineage = {
      _connection_ids: [...new Set(sources.map((s) => s.connectionId))].sort(),
      _connector_versions: [...new Set(sources.map((s) => String(s.connectorVersion)))].sort(),
      _ontology_version: manifest.version.id,
      _observed_at: startedAt,
    };

    for (let i = 0; i < objects.length; i += deps.batchRows) {
      const batch = objects.slice(i, i + deps.batchRows);
      const before = await deps.bigQuery.run(ref, readHashes(ref, tableName, batch.map((o) => o.id)), options);
      const hashes = new Map(before.rows.map((r) => [String(r[INDEX_KEY.name]), r['_row_hash']]));
      const rows = batch.map((o) => entryOf(o, definition, properties, columnOf, markings, lineage, startedAt));
      written += rows.filter((r) => hashes.get(String(r[INDEX_KEY.name])) !== r['_row_hash']).length;
      await stillLive();
      await deps.bigQuery.run(ref, mergeEntries(ref, tableName, columns, rows), options);
    }
    await stillLive();
    // Every entry this refresh observed carries its time: the rest were removed at the source.
    removed = (await deps.bigQuery.run(ref, removeUnobserved(ref, tableName, startedAt), options)).affectedRows ?? 0;

    await inTransaction(pool, ctx.request, async (db) => {
      await indexRefreshRepo.update(db, refreshId, {
        status: 'completed', objectsWritten: String(written), objectsRemoved: String(removed), completedAt: new Date().toISOString(),
      });
      const current = await indexDefinitionRepo.findById(db, definition.id);
      if (current !== undefined && current.removedAt === null) await indexDefinitionRepo.update(db, definition.id, { lastRefreshedAt: startedAt });
      await recordEvent(db, ctx.request, ctx.correlationId, {
        event: 'index_refreshed', resource: { type: 'silo', id: silo.id },
        detail: { definition_id: definition.id, trigger, objects: objects.length, written, removed },
      });
    });
  } catch (error) {
    if (isAppError(error) && error.code === 'index.purged') {
      // Whatever this refresh wrote before the purge was noticed goes with the purge.
      await deps.bigQuery.run(ref, dropTable(ref, tableName), options).catch(() => undefined);
    }
    const refused = isAppError(error) && error.code === 'index.read_refused';
    const reason = isAppError(error) && typeof error.details['reason'] === 'string' ? `:${error.details['reason']}` : '';
    const stage = isAppError(error) ? `${error.code}${reason}` : 'index.refresh_failed';
    await inTransaction(pool, ctx.request, async (db) => {
      await indexRefreshRepo.update(db, refreshId, {
        status: refused ? 'refused' : 'failed', errorStage: stage.slice(0, 200), objectsWritten: String(written), objectsRemoved: String(removed),
        completedAt: new Date().toISOString(),
      });
      await recordEvent(db, ctx.request, ctx.correlationId, {
        event: 'index_refresh_failed', resource: { type: 'silo', id: silo.id }, detail: { definition_id: definition.id, trigger, stage },
      });
    });
    deps.logger.failure('an Object Index refresh did not complete', error, { event: 'index.refresh_failed', organisationId: silo.organisationId });
  }
}

function entryOf(object: ResultObject, definition: IndexDefinition, properties: readonly NominatedProperty[], columnOf: Map<string, string>,
  markings: { object: string[]; byProperty: Map<string, string[]> }, lineage: Record<string, unknown>, refreshedAt: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    [INDEX_KEY.name]: object.id, _object_type_id: definition.objectTypeId, _index_definition_id: definition.id,
  };
  const held: Record<string, unknown> = {};
  const states: Record<string, string> = {};
  for (const p of properties) {
    const column = columnOf.get(p.apiName)!;
    const hidden = object.masked.includes(p.apiName) || object.redacted.includes(p.apiName);
    const disputed = object.disputed.includes(p.apiName);
    const value = hidden || disputed ? null : (object.values[p.apiName] ?? null);
    const state = hidden ? 'unchecked' : disputed ? 'disputed' : object.states[p.apiName] ?? (value === null ? 'empty' : 'only');
    row[column] = bind(value, p.type);
    row[markingColumnOf(column)] = markings.byProperty.get(p.apiName) ?? [];
    row[stateColumnOf(column)] = state;
    held[p.apiName] = value;
    states[p.apiName] = state;
  }
  const hash = createHash('sha256')
    .update(canonicalJson({ v: held, s: states, m: markings.object, p: Object.fromEntries(markings.byProperty) })).digest('hex');
  return { ...row, _marking_ids: markings.object, _row_hash: hash, _refreshed_at: refreshedAt, ...lineage };
}

/** The scheduled pass: each due definition is claimed once (its next time moved on), then refreshed. */
export async function refreshDue(deps: IndexDeps, correlationId: string, limit = 20): Promise<number> {
  const pool = deps.databases.pool('control');
  const due = await inTransaction(pool, {}, (db) => indexDefinitionRepo.listDue(db, limit), { readOnly: true });
  let started = 0;
  for (const d of due) {
    const claimed = await inTransaction(pool, { organisationId: d.organisationId }, async (db) => {
      const row = await indexDefinitionRepo.findById(db, d.id);
      if (row === undefined || row.nextRefreshAt === null || row.removedAt !== null) return false;
      const next = await nextRefreshAt(db, row.organisationId, row.refreshSchedule, Math.max(Date.now(), Date.parse(row.nextRefreshAt)));
      return indexDefinitionRepo.claimDue(db, row.id, row.nextRefreshAt, next);
    });
    if (claimed && await startRefresh(deps, d, 'schedule', correlationId) !== undefined) started += 1;
  }
  return started;
}
