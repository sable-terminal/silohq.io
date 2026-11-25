// The executor (spec 27): runs a validated plan against the sources where they sit and
// returns one result object (spec 27.9), or refuses. No model runs here.
//
// The result object carries:
//   columns, measures   what is shown, with each column's field-policy effect (mask and
//                       redact are shown, never filtered, sorted or grouped on);
//   page                the first page of objects (or groups); readResultPage serves the
//                       rest while the result lives in the data plane (15 minutes, re-armed
//                       on each read; spec 8.5);
//   coverage            objects, unmatched records, disputed and empty values per property,
//                       and objects excluded because a filter fell on a disputed value;
//   lineage             per column: object type version, ontology version and branch, the
//                       sources (connection, connector version, source object, field path,
//                       read time, what the source computed), the period and the route;
//   periods             each period's resolution: the words, the field, the half-open range
//                       and the calendar it was resolved against (spec 26.8);
//   localFilters        filters applied in the engine after a bounded read (spec 27.3).
// Objects: a Silo object id (spec 24.7), values by property API name with each value's
// state (declared, agreed, only, disputed, empty, unchecked), the names of disputed,
// masked and redacted values, whether a record stood alone for want of a match key, and
// the objects each hop reached, paired with the object they belong to.

import { z } from 'zod';
import { FILTER_OPS } from '../connect/manifest.contract.ts';
import { defineContract } from '../endpoint.contract.ts';
import { DATA_TYPES } from '../ontology/manifest.contract.ts';
import { setDefinition } from '../ontology/objectSet.contract.ts';
import { MEASURE_FUNCTIONS, planParameters, queryPlan, refusal } from '../planner/plan.contract.ts';
import { VALUE_STATES, type ValueState } from '../resolution/resolve.contract.ts';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export interface ResultObject {
  id: string;
  objectTypeId: string;
  /** Values by property API name. Record values. */
  values: Record<string, z.core.util.JSONType>;
  /**
   * Each shown value's state, by API name (spec 23.4, 23.5): declared (field authority chose
   * it), agreed, only, disputed, empty or unchecked (a system could not be asked).
   */
  states: Record<string, ValueState>;
  disputed: string[];
  masked: string[];
  redacted: string[];
  /** The record had no full match key set, so it stands alone (counted in coverage). */
  unmatched: boolean;
  /**
   * Where asked (references): the source records the object was merged from, by connection,
   * source object and identifier. Identifiers only: what a Cron's mutation names (40.5).
   */
  records?: { connectionId: string; sourceObject: string; reference: string }[] | undefined;
  /** Linked objects by hop index, paired with this object. */
  links: Record<string, ResultObject[]>;
  /**
   * A history question (69.16): each change in the period to a shown property, oldest first,
   * by property API name, with the value before and after. A value the reader's field policy
   * masks or redacts is withheld (null), its effect named.
   */
  changes?: { property: string; at: string; previous: z.core.util.JSONType; value: z.core.util.JSONType; withheld?: 'mask' | 'redact' | undefined }[] | undefined;
}

export const resultObject: z.ZodType<ResultObject> = z.object({
  id: z.uuid(),
  objectTypeId: z.uuid(),
  values: z.record(z.string(), z.json()),
  states: z.record(z.string(), z.enum(VALUE_STATES)),
  disputed: z.array(z.string()),
  masked: z.array(z.string()),
  redacted: z.array(z.string()),
  unmatched: z.boolean(),
  records: z.array(z.object({ connectionId: z.uuid(), sourceObject: z.string(), reference: z.string() })).optional(),
  get links() {
    return z.record(z.string(), z.array(resultObject));
  },
  changes: z.array(z.object({
    property: z.string(), at: z.string(), previous: z.json(), value: z.json(), withheld: z.enum(['mask', 'redact']).optional(),
  })).optional(),
});

export const resultGroup = z.object({
  /** Group key values by property API name. Record values. */
  key: z.record(z.string(), z.json()),
  /** Measure values by alias; null where nothing decided was left to measure. */
  measures: z.record(z.string(), z.number().nullable()),
  /** Root objects in the group. */
  objects: z.int(),
  /** Per measure, values left out because they were disputed or empty (spec 27.7). */
  excluded: z.record(z.string(), z.int()),
});
export type ResultGroup = z.infer<typeof resultGroup>;

export const periodResolution = z.object({
  node: z.int(),
  property: z.uuid(),
  propertyApiName: z.string(),
  asWritten: z.string(),
  /** Inclusive start and exclusive end: dates for a date field, instants for a timestamp. */
  from: z.string(),
  to: z.string(),
  basis: z.enum(['date', 'timestamp']),
  /** The type's declared default time field was used, and is named here. */
  defaultTimeField: z.boolean(),
  calendar: z.object({
    timeZone: z.string(),
    financialYearStartMonth: z.int().nullable(),
    financialYearStartDay: z.int(),
    weekStartDay: z.int(),
  }),
});
export type PeriodResolution = z.infer<typeof periodResolution>;

export const lineageSource = z.object({
  connectionId: z.uuid(),
  connectorVersion: z.string(),
  sourceObject: z.string(),
  fieldPath: z.string(),
  readAt: z.string(),
  /** What the source computed, rather than the engine. */
  pushdown: z.object({ filter: z.boolean(), sort: z.boolean(), aggregate: z.boolean() }),
});

export const columnLineage = z.object({
  node: z.int(),
  objectTypeVersionId: z.uuid(),
  ontologyVersionId: z.uuid(),
  branchId: z.uuid(),
  propertyIdentityId: z.uuid(),
  propertyApiName: z.string(),
  sources: z.array(lineageSource),
  /** The period that bounded the node, if any. */
  period: periodResolution.optional(),
  /**
   * Where the node was answered from other than its live sources (spec 69.6): the Object
   * Index as of its last refresh, or the Warehouse as of its watermark (or the instant an
   * as-of question asked), and why the planner chose it. Absent: read live now.
   */
  servedBy: z.object({ kind: z.enum(['index', 'warehouse']), asOf: z.string(), reason: z.string() }).optional(),
  /** A split plan (69.6): which objects are shown came from the Object Index as of its refresh; the values were read live. */
  narrowedBy: z.object({ kind: z.literal('index'), asOf: z.string(), reason: z.string() }).optional(),
  /** The hops from the root to the node: link type and route of each. */
  route: z.array(z.object({ linkTypeId: z.uuid(), routeId: z.uuid() })),
  coverage: z.object({ values: z.int(), empty: z.int(), disputed: z.int(), unchecked: z.int(), masked: z.int(), redacted: z.int() }),
});
export type ColumnLineage = z.infer<typeof columnLineage>;

export const resultColumn = z.object({
  node: z.int(),
  property: z.uuid(),
  apiName: z.string(),
  displayName: z.string(),
  dataType: z.enum(DATA_TYPES),
  effect: z.enum(['allow', 'mask', 'redact']),
});

export const queryResult = z.object({
  queryId: z.uuid(),
  planHash: hex64,
  ontologyVersionId: z.uuid(),
  kind: z.enum(['objects', 'groups']),
  columns: z.array(resultColumn),
  measures: z.array(z.object({ as: z.string(), fn: z.enum(MEASURE_FUNCTIONS), node: z.int(), property: z.uuid().optional() })),
  /** Root objects after filtering and merge, before any limit. */
  population: z.int(),
  /** Objects or groups in the answer, after the limit. */
  total: z.int(),
  page: z.object({
    index: z.int(),
    count: z.int(),
    objects: z.array(resultObject),
    groups: z.array(resultGroup),
  }),
  coverage: z.object({
    objects: z.int(),
    unmatched: z.int(),
    disputed: z.record(z.string(), z.int()),
    empty: z.record(z.string(), z.int()),
    /** Values no system could be asked about: unknown, not empty (spec 23.5). */
    unchecked: z.record(z.string(), z.int()),
    /** Objects left out because a filter fell on a disputed value: undecided, not small. */
    excludedByDispute: z.int(),
  }),
  lineage: z.array(columnLineage),
  periods: z.array(periodResolution),
  localFilters: z.array(z.object({ node: z.int(), connectionId: z.uuid(), field: z.string(), op: z.enum(FILTER_OPS) })),
  /**
   * The reader's access shaped the answer (spec 37.5): a field policy masked or redacted a
   * column. What the reader may not see at all is never named, so it cannot be flagged.
   */
  reduced: z.boolean(),
  /** merged: aggregates computed over merged objects after field authority (spec 27.7). */
  /** merged: over merged objects; partial_pushdown: the source computed it per group (spec 27.7). The answer states which. */
  aggregateForm: z.enum(['merged', 'partial_pushdown', 'warehouse']).nullable(),
  /** Computed against an ontology branch, not main (spec 25.3): said in every representation. Absent: main. */
  branch: z.object({ branchId: z.uuid(), kind: z.enum(['working', 'derivation', 'scenario']) }).optional(),
  /** A set over an interface, a traversal or a set operation (spec 21.9, 24.4): the types its members came from, and how many each. */
  contributingTypes: z.array(z.object({ objectTypeId: z.uuid(), objects: z.int() })).optional(),
  /** Defaults the engine used and names (spec 26.9): time fields and routes. */
  defaults: z.object({
    timeFields: z.array(z.object({ node: z.int(), property: z.uuid() })),
    routes: z.array(z.object({ hop: z.int(), routeId: z.uuid() })),
  }),
  cached: z.boolean(),
  computedAt: z.string(),
  /** A history question (69.16): the period, and the Warehouse that answered it; the changes are on each object. */
  history: z.object({ asWritten: z.string(), from: z.string(), to: z.string(), source: z.literal('warehouse'), watermark: z.string() }).optional(),
});
export type QueryResult = z.infer<typeof queryResult>;

export const runOutcome = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('answer'), result: queryResult }),
  z.object({ outcome: z.literal('refusal'), refusal }),
]);
export type RunOutcome = z.infer<typeof runOutcome>;

/** Why a plan ran. Only an authored compile is ever metered, and not here (spec 73.2). */
/**
 * Why a plan runs. explorer_facet: an Explorer facet's counts or range (34.1), which a fresh
 * Object Index may serve (69.3); nothing that feeds an Action preview runs as one.
 */
export const RUN_TRIGGERS = ['authored', 'saved_view_run', 'dashboard_refresh', 'alert_poll', 'cron_run', 'structured', 'explorer_facet', 'app_widget'] as const;

/**
 * How long a caller waits for a question to be run: the executor's wall-time bound at its
 * ceiling (EXECUTOR_WALL_TIME_MS, at most two minutes) and a margin to answer with the refusal
 * that bound gives. A question that runs long is refused at its bound, never cut off by its
 * caller first.
 */
export const RUN_TIMEOUT_MS = 130_000;

export const EXECUTOR_CALLERS = [
  'compile', 'ask', 'workspace', 'studio', 'scheduler', 'recognition', 'simulation', 'state-plane', 'canvas-layout', 'render',
  'warehouse-sync', 'warehouse-reconcile', 'index-builder',
  // files: a media set's link rule finds the objects its keys name, as the person (D238).
  'files',
] as const;

/**
 * Runs a plan, with its parameters. The executor reads the plan's own ontology version,
 * re-resolves the reader's access now (never trusting what compile saw), refuses rather
 * than truncates, and keeps the result in the data plane for its pages.
 */
export const runPlan = defineContract({
  service: 'executor', name: 'runPlan', method: 'POST', path: '/v1/runs',
  callers: EXECUTOR_CALLERS,
  // A run changes nothing at any source.
  // Answered or refused within the executor's wall-time bound.
  timeoutMs: RUN_TIMEOUT_MS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    plan: queryPlan,
    parameters: planParameters.default({}),
    /** The compiled plan this runs, when there is one: recorded with the query. */
    planId: z.uuid().optional(),
    trigger: z.enum(RUN_TRIGGERS).default('structured'),
    /** Each object's source records, by identifier (ResultObject.records): a Cron's mutate action needs them (40.5). */
    references: z.boolean().default(false),
    purposeSessionIds: z.array(z.uuid()).max(16).optional(),
    /** Answer from the data plane when the same plan ran for the same permissions within the cache TTL. */
    useCache: z.boolean().default(true),
  }),
  response: runOutcome,
  maxBodyBytes: 256 * 1024,
});

/**
 * Runs a saved object set (spec 24.4): its definition re-evaluated now, against main's head,
 * under the caller's own access. A filter set reads its base type and keeps the objects its
 * predicate holds for, on decided values; an explicit set keeps its listed objects. The
 * predicate's properties must be visible with no field policy, as a filter's. Traversal and
 * composite sets are refused until the engine walks them.
 */
export const runObjectSet = defineContract({
  service: 'executor', name: 'runObjectSet', method: 'POST', path: '/v1/object-set-runs',
  // gateway: Explorer shows what a saved object set holds (U6), under the reader's access.
  callers: [...EXECUTOR_CALLERS, 'gateway'],
  // Answered or refused within the executor's wall-time bound.
  timeoutMs: RUN_TIMEOUT_MS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectSetId: z.uuid().optional(),
    /** studio: an app's object set variable (35.2), given whole rather than saved; evaluated exactly as a saved one. */
    definition: setDefinition.optional(),
    /** Values for the names the predicate reads besides object and now (an app's parameter variables): bound, never written into the CEL. */
    bindings: z.record(z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/), z.union([z.string().max(1_000), z.number(), z.boolean(), z.null(), z.array(z.union([z.string().max(1_000), z.number()])).max(100)])).optional(),
    /** Property identities to show besides the title. */
    select: z.array(z.uuid()).max(200).default([]),
    trigger: z.enum(RUN_TRIGGERS).default('saved_view_run'),
    purposeSessionIds: z.array(z.uuid()).max(16).optional(),
    useCache: z.boolean().default(true),
  }).refine((b) => (b.objectSetId === undefined) !== (b.definition === undefined), { message: 'name a saved set or give a definition, exactly one' })
    .refine((b) => b.bindings === undefined || b.definition !== undefined, { path: ['bindings'], message: 'bindings go with a definition given whole' }),
  response: runOutcome,
  maxBodyBytes: 64 * 1024,
});

/**
 * A result as its own actor reads it again while it lives (spec 31.2): its header (columns, measures,
 * coverage, lineage, periods, flags) and its first page, so every representation is drawn from the
 * one result object without running the plan again.
 */
export const readResult = defineContract({
  service: 'executor', name: 'readResult', method: 'GET', path: '/v1/results/:queryId',
  callers: ['gateway', ...EXECUTOR_CALLERS],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ queryId: z.uuid() }),
  response: queryResult,
});

/** A further page of a result, for the actor whose result it is, while it lives. */
export const readResultPage = defineContract({
  service: 'executor', name: 'readResultPage', method: 'GET', path: '/v1/results/:queryId/pages/:page',
  callers: ['gateway', ...EXECUTOR_CALLERS],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ queryId: z.uuid(), page: z.coerce.number().int().min(0).max(100_000) }),
  response: z.object({
    queryId: z.uuid(),
    index: z.int(),
    count: z.int(),
    objects: z.array(resultObject),
    groups: z.array(resultGroup),
  }),
});
