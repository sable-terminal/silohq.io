// index-builder (spec 69.1 to 69.11): the Object Index as people manage it. Creating one
// (silo.create) makes the Silo, its own automation principal (owned by the creator, bounded
// by them at run time) and its dataset. Object types are nominated one at a time, with the
// properties to hold, a refresh schedule, and no cascade (silo.manage, 66.6); a person who
// cannot see the type or a property cannot nominate it (69.5). Each nomination grants the
// principal read on the type's connections, in the nominator's authority, and its first
// refresh builds the entry table at once.
//
// The Silo stays 'provisioning' while the federated engine cannot route questions to it
// (66.5 needs a Silo source connection, not built); search reaches it through this service.

import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { createServicePrincipal, grantConnection } from '../../contracts/policy/governance.contract.ts';
import type { IndexDefinitionView, ObjectIndexView } from '../../contracts/index-builder/index.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { idTail, labelValue, type BigQueryAdapter, type DatasetRef } from '../../infra/bigquery.infra.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { IndexDefinition, IndexRefresh, Silo } from '../../models/siloes/index.model.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { indexDefinitionRepo, indexRefreshRepo, siloRepo } from '../../repos/siloes/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { checkSchedule, nextOccurrence, parseSchedule, validTimeZone } from '../scheduler/schedule.service.ts';
import { requireSiloes } from '../siloes-capture/deps.service.ts';
import { dropTable, readIndexPage, removeUnobserved } from '../warehouse-schema/generator/index.generator.ts';
import { nominatedProperties, type NominatedProperty } from '../warehouse-schema/schema.service.ts';
import { demand, readManifest, recordEvent } from '../warehouse-schema/warehouse.service.ts';

export interface IndexDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  bigQuery: BigQueryAdapter;
  /** The cell's siloes project: Object Index datasets live here. */
  projectId: string;
  /** Rows written per MERGE. */
  batchRows: number;
  /** Results one index search returns at most (OBJECT_INDEX_MAX_RESULTS). */
  maxResults: number;
  /** The shortest refresh schedule, as for every schedule (SCHEDULER_MIN_INTERVAL_MINUTES). */
  minIntervalMinutes: number;
}

export type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

export const TIME_TRAVEL_HOURS = 48;

/** A unique key refused the write (database errors arrive as AppErrors carrying the SQL state). */
export const isUniqueViolation = (error: unknown): boolean => error instanceof AppError && error.details['sqlstate'] === '23505';
const NOT_PERMITTED = 'index.not_permitted';

/** idx_<org12>_<silo12> (design: naming rules). */
export const indexDatasetOf = (organisationId: string, siloId: string): string => `idx_${idTail(organisationId, 12)}_${idTail(siloId, 12)}`;

/** One table per definition, named by its id so a renamed type keeps its table. */
export const indexTableOf = (definitionId: string): string => `ix__${definitionId.replaceAll('-', '')}`;

export const datasetRef = (deps: Pick<IndexDeps, 'projectId'>, silo: Pick<Silo, 'storeRef'>): DatasetRef => ({
  projectId: deps.projectId, dataset: silo.storeRef!,
});

export function datasetLabels(silo: Pick<Silo, 'id' | 'organisationId'>): Record<string, string> {
  return { organisation: labelValue(silo.organisationId), service: 'index-builder', silo: labelValue(silo.id) };
}

/** The Silo's principal as the actor of a refresh. */
export function asIndex(silo: Pick<Silo, 'organisationId' | 'servicePrincipalId'>, correlationId: string): Context {
  if (silo.servicePrincipalId === null) {
    throw new AppError('integrity', 'the Object Index has no principal to act as', { code: 'index.no_principal' });
  }
  return { request: { organisationId: silo.organisationId, servicePrincipalId: silo.servicePrincipalId }, correlationId };
}

function person(ctx: Context): string {
  if (ctx.request.membershipId === undefined) {
    throw new AppError('forbidden', 'an Object Index is managed by a person', { code: 'index.person_required' });
  }
  return ctx.request.membershipId;
}

export async function loadIndexSilo(db: Queryable, siloId: string): Promise<Silo> {
  const silo = await siloRepo.findById(db, siloId);
  if (silo === undefined || silo.kind !== 'object_index') throw new AppError('not_found', 'no such Object Index', { code: 'index.not_found' });
  return silo;
}

function open(silo: Silo): Silo {
  if (silo.status === 'purging' || silo.status === 'disabled' || silo.disabledAt !== null) {
    throw new AppError('conflict', 'the Object Index is closed', { code: 'index.closed' });
  }
  return silo;
}

/** The next time a schedule fires, in the organisation's time zone. */
export async function nextRefreshAt(db: Queryable, organisationId: string, schedule: string, after: number): Promise<string | null> {
  const zone = (await organisationRepo.findById(db, organisationId))?.calendarTimeZone ?? 'UTC';
  const timezone = validTimeZone(zone) ? zone : 'UTC';
  const next = nextOccurrence(parseSchedule(schedule), after, timezone);
  return next === undefined ? null : new Date(next).toISOString();
}

// ----------------------------------------------------------------------------- views

export function refreshView(r: IndexRefresh): NonNullable<IndexDefinitionView['lastRefresh']> {
  return {
    id: r.id, trigger: r.trigger, status: r.status, objectsWritten: Number(r.objectsWritten), objectsRemoved: Number(r.objectsRemoved),
    startedAt: r.startedAt, completedAt: r.completedAt, errorStage: r.errorStage,
  };
}

export function definitionView(d: IndexDefinition, last: IndexRefresh | undefined): IndexDefinitionView {
  return {
    id: d.id, objectTypeId: d.objectTypeId, properties: d.nominatedProperties, refreshSchedule: d.refreshSchedule, usesChangeStream: d.usesChangeStream,
    tableName: indexTableOf(d.id), addedAt: d.addedAt, removedAt: d.removedAt, lastRefreshedAt: d.lastRefreshedAt, nextRefreshAt: d.nextRefreshAt,
    lastRefresh: last === undefined ? null : refreshView(last),
  };
}

async function indexView(db: Queryable, silo: Silo): Promise<ObjectIndexView> {
  const definitions = await indexDefinitionRepo.listForSilo(db, silo.id, false);
  const latest = new Map((await indexRefreshRepo.latestFor(db, definitions.map((d) => d.id))).map((r) => [r.indexDefinitionId, r]));
  return {
    id: silo.id, name: silo.name, purpose: silo.purpose, retentionDays: silo.retentionDays, status: silo.status, location: silo.location,
    dataset: silo.storeRef ?? '', createdAt: silo.createdAt, definitions: definitions.map((d) => definitionView(d, latest.get(d.id))),
  };
}

export function loadIndexView(deps: Pick<IndexDeps, 'databases'>, ctx: Context, siloId: string): Promise<ObjectIndexView> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => indexView(db, await loadIndexSilo(db, siloId)), { readOnly: true });
}

// ----------------------------------------------------------------------------- creating

export async function createObjectIndex(deps: IndexDeps, ctx: Context, input: { name: string; purpose: string; retentionDays: number })
  : Promise<ObjectIndexView> {
  const creator = person(ctx);
  const organisationId = ctx.request.organisationId!;
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.create', NOT_PERMITTED);
  const call = { request: ctx.request, correlationId: ctx.correlationId };
  const principal = await deps.services.call(createServicePrincipal, { body: { kind: 'automation', name: 'Object Index' } }, call);
  const siloId = uuidv7();
  const dataset = indexDatasetOf(organisationId, siloId);
  const silo = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const row = await siloRepo.insert(db, {
      id: siloId, organisationId, kind: 'object_index', name: input.name, purpose: input.purpose, retentionDays: input.retentionDays,
      location: deps.bigQuery.location, status: 'provisioning', storeRef: dataset, servicePrincipalId: principal.id, createdBy: creator,
    });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'silo_created', resource: { type: 'silo', id: siloId }, detail: { kind: 'object_index', retention_days: input.retentionDays },
    });
    return row;
  });
  // Location is enforced at creation (66.8): the adapter is pinned to the cell's region.
  await deps.bigQuery.ensureDataset(datasetRef(deps, silo), { maxTimeTravelHours: TIME_TRAVEL_HOURS, labels: datasetLabels(silo) });
  return loadIndexView(deps, ctx, silo.id);
}

/** The index as siloes-capture reads it to rebuild after a move (D212): Siloes on, no person's permission. */
export async function indexViewForMove(deps: IndexDeps, ctx: Context, siloId: string): Promise<ObjectIndexView> {
  await requireSiloes(deps, ctx);
  return loadIndexView(deps, ctx, siloId);
}

export async function getObjectIndex(deps: IndexDeps, ctx: Context, siloId: string): Promise<ObjectIndexView> {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.manage', NOT_PERMITTED);
  return loadIndexView(deps, ctx, siloId);
}

// ----------------------------------------------------------------------------- nominating

/**
 * The properties nominated, as the ontology has them, after the clearance check (69.5): the
 * nominator must see the type and every property in full.
 */
async function cleared(deps: IndexDeps, ctx: Context, manifest: OntologyManifest, objectTypeId: string, apiNames: readonly string[])
  : Promise<NominatedProperty[]> {
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId && t.status === 'active');
  if (type === undefined) throw new AppError('validation', 'the object type is not in the ontology', { code: 'index.unknown_type' });
  const found = nominatedProperties(manifest, objectTypeId, apiNames);
  const unknown = apiNames.filter((a) => !found.some((f) => f.apiName === a));
  if (unknown.length > 0) {
    throw new AppError('validation', `${type.apiName} has no property ${unknown[0]}`, { code: 'index.unknown_property', details: { property: unknown[0]! } });
  }
  const access = await deps.services.call(resolveAccess, {
    body: { objectTypes: [objectTypeId], properties: found.map((p) => p.identityId) },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  if (access.decision !== 'allow' || access.objectTypes.find((t) => t.id === objectTypeId)?.visible !== true) {
    throw new AppError('forbidden', 'you cannot nominate an object type you cannot see', { code: 'index.not_cleared' });
  }
  for (const p of found) {
    const seen = access.properties.find((a) => a.id === p.identityId);
    if (seen?.visible !== true || seen.effect !== 'allow') {
      throw new AppError('forbidden', `you cannot nominate ${p.apiName}: you do not see it in full`, { code: 'index.not_cleared', details: { property: p.apiName } });
    }
  }
  return found;
}

/** The principal reads the type's connections: granted in the nominator's authority. */
async function grantReads(deps: IndexDeps, ctx: Context, silo: Silo, manifest: OntologyManifest, objectTypeId: string): Promise<void> {
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId)!;
  for (const connectionId of new Set(type.contributingObjects.map((c) => c.connectionId))) {
    await deps.services.call(grantConnection, {
      body: { connectionId, grantee: { kind: 'service_principal', id: silo.servicePrincipalId! }, access: 'read', includeDescendants: true },
    }, { request: ctx.request, correlationId: ctx.correlationId });
  }
}

export async function addIndexType(deps: IndexDeps, ctx: Context, siloId: string, input: {
  objectTypeId: string; properties: string[]; refreshSchedule: string; usesChangeStream: boolean;
}): Promise<{ definition: IndexDefinitionView; row: IndexDefinition }> {
  const nominator = person(ctx);
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.manage', NOT_PERMITTED);
  const pool = deps.databases.pool('control');
  const silo = await inTransaction(pool, ctx.request, async (db) => open(await loadIndexSilo(db, siloId)), { readOnly: true });
  const manifest = await readManifest(deps, ctx);
  await cleared(deps, ctx, manifest, input.objectTypeId, input.properties);
  const now = Date.now();
  const timezone = await inTransaction(pool, ctx.request, async (db) => (await organisationRepo.findById(db, silo.organisationId))?.calendarTimeZone ?? 'UTC',
    { readOnly: true });
  const schedule = checkSchedule(input.refreshSchedule, validTimeZone(timezone) ? timezone : 'UTC', deps.minIntervalMinutes, now);
  const next = nextOccurrence(schedule, now, validTimeZone(timezone) ? timezone : 'UTC');
  await grantReads(deps, ctx, silo, manifest, input.objectTypeId);
  const row = await inTransaction(pool, ctx.request, async (db) => {
    const inserted = await indexDefinitionRepo.insert(db, {
      id: uuidv7(), organisationId: silo.organisationId, siloId: silo.id, objectTypeId: input.objectTypeId, nominatedProperties: input.properties,
      refreshSchedule: input.refreshSchedule, usesChangeStream: input.usesChangeStream, addedBy: nominator,
      nextRefreshAt: next === undefined ? null : new Date(next).toISOString(),
    });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'index_type_added', resource: { type: 'silo', id: silo.id },
      detail: { definition_id: inserted.id, object_type_id: input.objectTypeId, properties: input.properties.join(','), schedule: input.refreshSchedule },
    });
    return inserted;
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new AppError('conflict', 'that object type is already in this Object Index', { code: 'index.type_present' });
    throw error;
  });
  return { definition: definitionView(row, undefined), row };
}

export async function changeIndexProperties(deps: IndexDeps, ctx: Context, siloId: string, definitionId: string, properties: string[])
  : Promise<{ definition: IndexDefinitionView; row: IndexDefinition }> {
  person(ctx);
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.manage', NOT_PERMITTED);
  const pool = deps.databases.pool('control');
  const { silo, before } = await inTransaction(pool, ctx.request, async (db) => {
    const silo = open(await loadIndexSilo(db, siloId));
    const before = await indexDefinitionRepo.findById(db, definitionId);
    if (before === undefined || before.siloId !== silo.id || before.removedAt !== null) {
      throw new AppError('not_found', 'no such nomination', { code: 'index.definition_not_found' });
    }
    return { silo, before };
  }, { readOnly: true });
  const manifest = await readManifest(deps, ctx);
  await cleared(deps, ctx, manifest, before.objectTypeId, properties);
  const row = await inTransaction(pool, ctx.request, async (db) => {
    const updated = (await indexDefinitionRepo.update(db, definitionId, { nominatedProperties: properties }))!;
    // Read first by a reviewer: adding a property extends what is copied (69.10).
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'index_properties_changed', resource: { type: 'silo', id: silo.id },
      detail: { definition_id: definitionId, previous: before.nominatedProperties.join(','), current: properties.join(',') },
    });
    return updated;
  });
  return { definition: definitionView(row, undefined), row };
}

export async function removeIndexType(deps: IndexDeps, ctx: Context, siloId: string, definitionId: string): Promise<IndexDefinitionView> {
  person(ctx);
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.manage', NOT_PERMITTED);
  const pool = deps.databases.pool('control');
  const { silo, row } = await inTransaction(pool, ctx.request, async (db) => {
    const silo = await loadIndexSilo(db, siloId);
    const before = await indexDefinitionRepo.findById(db, definitionId);
    if (before === undefined || before.siloId !== silo.id) throw new AppError('not_found', 'no such nomination', { code: 'index.definition_not_found' });
    if (before.removedAt !== null) return { silo, row: before };
    const row = (await indexDefinitionRepo.update(db, definitionId, { removedAt: new Date().toISOString(), nextRefreshAt: null }))!;
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'index_type_removed', resource: { type: 'silo', id: silo.id }, detail: { definition_id: definitionId, object_type_id: row.objectTypeId },
    });
    return { silo, row };
  });
  // The entries go with the nomination.
  const ref = datasetRef(deps, silo);
  if (await deps.bigQuery.getDataset(ref) !== undefined) {
    await deps.bigQuery.run(ref, dropTable(ref, indexTableOf(definitionId)), {
      labels: { organisation: silo.organisationId, service: 'index-builder', purpose: 'index_refresh', silo: silo.id },
    });
  }
  return definitionView(row, undefined);
}

/**
 * Purge index (70.2), run by the Silo purge path: one object type's nominations end and
 * their tables go, or, for the whole index, every nomination ends and the dataset goes.
 */
export async function purgeObjectIndex(deps: IndexDeps, ctx: Context, siloId: string, objectTypeId?: string)
  : Promise<{ dataset: string; dropped: boolean; definitions: number; entries: number }> {
  const pool = deps.databases.pool('control');
  const { silo, ended } = await inTransaction(pool, ctx.request, async (db) => {
    const silo = await loadIndexSilo(db, siloId);
    const live = (await indexDefinitionRepo.listForSilo(db, silo.id, true)).filter((d) => objectTypeId === undefined || d.objectTypeId === objectTypeId);
    const at = new Date().toISOString();
    for (const d of live) await indexDefinitionRepo.update(db, d.id, { removedAt: at, nextRefreshAt: null });
    return { silo, ended: live };
  });
  const ref = datasetRef(deps, silo);
  let entries = 0;
  let dropped = false;
  if (await deps.bigQuery.getDataset(ref) !== undefined) {
    for (const d of ended) entries += (await deps.bigQuery.getTable({ ...ref, table: indexTableOf(d.id) }))?.rows ?? 0;
    if (objectTypeId === undefined) {
      dropped = (await deps.bigQuery.deleteDataset(ref)).deleted;
    } else {
      const labels = { organisation: silo.organisationId, service: 'index-builder', purpose: 'index_refresh' as const, silo: silo.id };
      for (const d of ended) await deps.bigQuery.run(ref, dropTable(ref, indexTableOf(d.id)), { labels });
    }
  }
  await inTransaction(pool, ctx.request, (db) => recordEvent(db, ctx.request, ctx.correlationId, {
    event: 'index_purged', resource: { type: 'silo', id: silo.id },
    detail: { dataset: ref.dataset, definitions: ended.length, entries, object_type_id: objectTypeId ?? null }, service: 'index-builder',
  }));
  return { dataset: ref.dataset, dropped, definitions: ended.length, entries };
}

/** The retention sweep (70.1): entries not refreshed within the window leave each live table. */
export async function sweepIndex(deps: IndexDeps, ctx: Context, siloId: string, refreshedBefore: string): Promise<{ tables: number; entriesRemoved: number }> {
  const pool = deps.databases.pool('control');
  const { silo, live } = await inTransaction(pool, ctx.request, async (db) => {
    const silo = await loadIndexSilo(db, siloId);
    return { silo, live: await indexDefinitionRepo.listForSilo(db, silo.id, true) };
  }, { readOnly: true });
  const ref = datasetRef(deps, silo);
  const labels = { organisation: silo.organisationId, service: 'index-builder', purpose: 'index_refresh' as const, silo: silo.id };
  let tables = 0;
  let entriesRemoved = 0;
  for (const d of live) {
    if (await deps.bigQuery.getTable({ ...ref, table: indexTableOf(d.id) }) === undefined) continue;
    tables += 1;
    entriesRemoved += (await deps.bigQuery.run(ref, removeUnobserved(ref, indexTableOf(d.id), refreshedBefore), { labels })).affectedRows ?? 0;
  }
  return { tables, entriesRemoved };
}

// ----------------------------------------------------------------------------- the organisation export

/**
 * A page of a nominated type's entries for the organisation export (spec 2.6). Only
 * org-export calls it, for an export a holder of org.export asked for (the gateway checked);
 * the run is in the background, with no session behind it to decide again here.
 */
export async function exportIndexPage(deps: IndexDeps, ctx: Context, input: { definitionId: string; after?: string | undefined; limit: number })
  : Promise<{ siloId: string; objectTypeId: string; refreshedAt: string | null; entries: string[]; next: string | null }> {
  const { definition, silo } = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const definition = await indexDefinitionRepo.findById(db, input.definitionId);
    if (definition === undefined) throw new AppError('not_found', 'no such index nomination', { code: 'index.definition_unknown' });
    return { definition, silo: await loadIndexSilo(db, definition.siloId) };
  }, { readOnly: true });
  const base = { siloId: silo.id, objectTypeId: definition.objectTypeId, refreshedAt: definition.lastRefreshedAt };
  if (definition.lastRefreshedAt === null) return { ...base, entries: [], next: null };
  const ref = datasetRef(deps, silo);
  const { rows } = await deps.bigQuery.run(ref, readIndexPage(ref, indexTableOf(definition.id), input.after ?? '', input.limit),
    { labels: { organisation: silo.organisationId, service: 'index-builder', purpose: 'index_search', silo: silo.id } });
  const entries = rows.map((r) => String(r['row']));
  return { ...base, entries, next: entries.length < input.limit ? null : String(rows.at(-1)!['key']) };
}
