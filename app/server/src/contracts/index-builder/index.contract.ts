// The Object Index (spec 69.1 to 69.11; catalogue: index-builder): a Silo holding a copy of
// the properties an organisation nominates, so search and Explorer lists answer where the
// sources cannot. It is a Silo in every respect: created with a purpose and a retention
// window (silo.create), its object types and properties nominated one at a time with no
// cascade (silo.manage), purged with silo.purge through the Silo purge path.
//
// - Nominating needs clearance: a person who cannot see the object type or a property
//   cannot nominate it (69.5). Adding a property is audited with both lists (69.10).
// - Refresh: a scheduled bounded query per type, as the Silo's own service principal,
//   bounded by its owner at run time; an object gone from its sources leaves the index at
//   the next refresh that observes its absence (69.4).
// - Search (69.3, 69.5): the search service asks; the index answers only what the reader may
//   see (both gates, deny wins), each result with the time of its last refresh, never as live.
//   The index is a search structure, not a source of record: no Action, Function or
//   scenario reads values from it.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { VALUE_STATES } from '../resolution/resolve.contract.ts';

export const INDEX_EVENTS = [
  'index_type_added', 'index_type_removed', 'index_properties_changed', 'index_refreshed', 'index_refresh_failed', 'index_rebuilt',
  'index_purged',
] as const;
export type IndexEventName = (typeof INDEX_EVENTS)[number];

const apiName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const properties = z.array(apiName).min(1).max(100).refine((p) => new Set(p).size === p.length, 'a property is nominated once');
const cron = z.string().trim().regex(/^\S+(\s+\S+){4}$/, 'a schedule is five fields: minute hour day-of-month month day-of-week');
const instant = z.string();

export const indexRefreshView = z.object({
  id: z.uuid(),
  trigger: z.enum(['schedule', 'change_stream', 'rebuild']),
  status: z.enum(['running', 'completed', 'failed', 'refused']),
  objectsWritten: z.int(),
  objectsRemoved: z.int(),
  startedAt: instant,
  completedAt: instant.nullable(),
  /** The failing stage and, for a refusal, the engine's code: never a value. */
  errorStage: z.string().nullable(),
});

export const indexDefinitionView = z.object({
  id: z.uuid(),
  objectTypeId: z.uuid(),
  properties: z.array(z.string()),
  refreshSchedule: z.string(),
  usesChangeStream: z.boolean(),
  tableName: z.string(),
  addedAt: instant,
  removedAt: instant.nullable(),
  lastRefreshedAt: instant.nullable(),
  nextRefreshAt: instant.nullable(),
  lastRefresh: indexRefreshView.nullable(),
});
export type IndexDefinitionView = z.infer<typeof indexDefinitionView>;

export const objectIndexView = z.object({
  id: z.uuid(),
  name: z.string(),
  purpose: z.string(),
  retentionDays: z.int(),
  status: z.string(),
  location: z.string(),
  dataset: z.string(),
  createdAt: instant,
  definitions: z.array(indexDefinitionView),
});
export type ObjectIndexView = z.infer<typeof objectIndexView>;

const siloParams = z.strictObject({ siloId: z.uuid() });
const definitionParams = siloParams.extend({ definitionId: z.uuid() });

export const createObjectIndex = defineContract({
  service: 'index-builder', name: 'createObjectIndex', method: 'POST', path: '/v1/object-indexes',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    name: z.string().trim().min(1).max(200),
    purpose: z.string().trim().min(1).max(2000),
    /** Required at creation and never defaulted (66.6). */
    retentionDays: z.int().min(1).max(36_500),
  }),
  response: objectIndexView, status: 201,
});

export const getObjectIndex = defineContract({
  service: 'index-builder', name: 'getObjectIndex', method: 'GET', path: '/v1/object-indexes/:siloId',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  response: objectIndexView,
});

export const addIndexType = defineContract({
  service: 'index-builder', name: 'addIndexType', method: 'POST', path: '/v1/object-indexes/:siloId/types',
  callers: ['gateway'],
  shed: 'index_rebuild', context: 'organisation', idempotency: 'none',
  params: siloParams,
  body: z.strictObject({
    objectTypeId: z.uuid(),
    /** API names of the properties to hold. Nothing else of the type is ever copied (69.2). */
    properties,
    /** Five-field cron, read in the organisation's time zone; shown in the disclosure (69.4). */
    refreshSchedule: cron,
    usesChangeStream: z.boolean().default(false),
  }),
  response: indexDefinitionView, status: 201,
});

export const changeIndexProperties = defineContract({
  service: 'index-builder', name: 'changeIndexProperties', method: 'POST', path: '/v1/object-indexes/:siloId/types/:definitionId/properties',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: definitionParams,
  body: z.strictObject({ properties }),
  response: indexDefinitionView,
});

export const removeIndexType = defineContract({
  service: 'index-builder', name: 'removeIndexType', method: 'POST', path: '/v1/object-indexes/:siloId/types/:definitionId/remove',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: definitionParams,
  response: indexDefinitionView,
});

export const rebuildIndexType = defineContract({
  service: 'index-builder', name: 'rebuildIndexType', method: 'POST', path: '/v1/object-indexes/:siloId/types/:definitionId/rebuild',
  // siloes-capture: an index the organisation brought from another cell is rebuilt here (6.4; D212).
  callers: ['gateway', 'siloes-capture'],
  shed: 'index_rebuild', context: 'organisation', idempotency: 'none',
  params: definitionParams,
  response: z.object({ refreshId: z.uuid() }), status: 202,
});

export const NOT_INDEXED_REASONS = ['not_indexed', 'not_refreshed', 'withheld', 'no_access'] as const;

/**
 * The organisation export (spec 2.6: Siloes "index contents"): a page of one nominated
 * type's entries, whole, each as the JSON of its row, markings included. Only org-export
 * calls it, for an export asked for by a holder of org.export; the export omits the type,
 * named, if any entry carries a marking its requester was not cleared for.
 */
export const exportObjectIndex = defineContract({
  service: 'index-builder', name: 'exportObjectIndex', method: 'POST', path: '/v1/object-index-exports',
  callers: ['org-export'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    definitionId: z.uuid(),
    /** The last entry key of the page before; absent for the first. */
    after: z.string().max(500).optional(),
    limit: z.int().min(1).max(5_000).default(1_000),
  }),
  response: z.object({
    siloId: z.uuid(),
    objectTypeId: z.uuid(),
    refreshedAt: z.string().nullable(),
    /** Each entry's row as JSON text. */
    entries: z.array(z.string()),
    next: z.string().nullable(),
  }),
  maxBodyBytes: 4_096,
});

/**
 * The planner's coverage question (spec 69.6; decision 2026-11-14): for each type, the
 * properties a refreshed live nomination holds and its watermark. Metadata only.
 */
export const objectIndexCoverage = defineContract({
  // buildProgram runs in the planner (explaining) and the executor (running).
  service: 'index-builder', name: 'objectIndexCoverage', method: 'POST', path: '/v1/object-index-coverage', callers: ['planner', 'executor'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ objectTypeIds: z.array(z.uuid()).min(1).max(100) }),
  response: z.object({ types: z.array(z.object({ objectTypeId: z.uuid(), held: z.array(z.uuid()), refreshedAt: instant })) }),
});

/**
 * The executor's read of one type from the index (69.6), in the reader's own request: the
 * entries matching every filter, among a split plan's keys where given, as last refreshed.
 * Not indexed (and why) where search would not answer either; the planner then reads live.
 */
export const readObjectIndex = defineContract({
  service: 'index-builder', name: 'readObjectIndex', method: 'POST', path: '/v1/object-index-reads', callers: ['executor'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    properties: z.array(z.uuid()).min(1).max(200),
    filters: z.array(z.strictObject({
      property: z.uuid(), op: z.enum(['eq', 'neq', 'in', 'lt', 'lte', 'gt', 'gte', 'is_null', 'not_null']),
      value: z.union([z.string().max(1000), z.number(), z.boolean(), z.array(z.union([z.string().max(1000), z.number()])).max(1000)]).optional(),
    })).max(50),
    keys: z.array(z.uuid()).max(10_000).optional(),
    limit: z.int().min(1).max(100_000),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('read'), refreshedAt: instant, exact: z.boolean(),
      /** Entries left out because the first filter they did not meet fell on a disputed value (as the engine counts them). */
      excludedByDispute: z.int().min(0),
      /** Each value's state as the engine decided it at the refresh, by API name (none from a refresh before states were recorded). */
      rows: z.array(z.object({ objectId: z.uuid(), values: z.record(z.string(), z.json()), states: z.record(z.string(), z.enum(VALUE_STATES)) })),
    }),
    z.object({ outcome: z.literal('not_indexed'), reason: z.enum(NOT_INDEXED_REASONS) }),
  ]),
});

/** The search service's question to the index, in the reader's own request. */
export const searchObjectIndex = defineContract({
  service: 'index-builder', name: 'searchObjectIndex', method: 'POST', path: '/v1/object-index-searches',
  callers: ['search'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    text: z.string().min(1).max(200),
    objectTypeIds: z.array(z.uuid()).min(1).max(50),
    limit: z.int().min(1).max(1_000),
  }),
  response: z.object({
    /** Types answered from the index: matched on their title, as last refreshed. */
    searched: z.array(z.object({ objectTypeId: z.uuid(), refreshedAt: instant, matches: z.int(), exact: z.boolean() })),
    /** Types the index did not answer, and why; the search service asks the sources for these. */
    notIndexed: z.array(z.object({ objectTypeId: z.uuid(), reason: z.enum(NOT_INDEXED_REASONS) })),
    results: z.array(z.object({ objectTypeId: z.uuid(), objectId: z.uuid(), title: z.string().nullable(), refreshedAt: instant })),
  }),
});

/**
 * Purge index (70.2), run by the Silo purge path (siloes-capture): one object type's entries,
 * or the whole index, its dataset and every table with it.
 */
export const purgeObjectIndex = defineContract({
  service: 'index-builder', name: 'purgeObjectIndex', method: 'POST', path: '/v1/object-indexes/:siloId/purge',
  callers: ['siloes-capture'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  body: z.strictObject({ objectTypeId: z.uuid().optional() }),
  response: z.object({ dataset: z.string(), dropped: z.boolean(), definitions: z.int(), entries: z.int() }),
});

/** The retention sweep (70.1): entries not refreshed within the window leave the index. */
export const sweepObjectIndex = defineContract({
  service: 'index-builder', name: 'sweepObjectIndex', method: 'POST', path: '/v1/object-indexes/:siloId/retention',
  callers: ['siloes-capture'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  body: z.strictObject({ refreshedBefore: z.iso.datetime({ offset: true }) }),
  response: z.object({ tables: z.int(), entriesRemoved: z.int() }),
});
