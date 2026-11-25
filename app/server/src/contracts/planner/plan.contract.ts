// The query plan (spec 26.7, 27): the one structure the compile stage produces, the planner
// decomposes, the executor runs, and Ask, saved views, Studio and Crons store and replay.
// It names the ontology only by id, so a plan means the same thing whoever reads it, and it
// is bound to the ontology version it was compiled against.
//
// Shape (QueryPlan, schemaVersion '1'):
//   ontologyVersionId   the version every id below belongs to. The executor reads that
//                       version's manifest, never main's head, so a merge never changes
//                       what a stored plan means.
//   nodes[]             object types, nodes[0] the root. Each: objectTypeId, filters (a
//                       property identity id, an operator, and a parameter reference for
//                       the value), and at most one period on a declared time field.
//   hops[]              link traversals forming a tree rooted at node 0: from a node to a
//                       later node along a link type and the route it takes (spec 26.11:
//                       a join uses only declared link types and states the route of
//                       each hop). Linked objects come back paired with the object they
//                       belong to, never flattened into rows.
//   select[]            the properties shown, each as { node, property }.
//   aggregate           optional: groupBy on root properties and measures (count, sum,
//                       min, max, avg, count_distinct) over any node. Measures over a hop
//                       count each linked object once per group (spec 26.11).
//   sort[]              by a root property or a measure; disputed and empty values last
//                       in either direction (spec 27.6).
//   limit               applied after ordering the whole merged population, never to a
//                       partial one (spec 27.6).
//   asOf                optional: the root type as it stood at an instant (spec 69.6), the
//                       instant a parameter like a period's ends. Answered from the
//                       Warehouse's history or refused; one node, no aggregate, no period.
//   history             optional: how the root type's selected properties changed over a
//                       period (spec 69.16: history questions read the Warehouse's history
//                       tables). The objects as they stood at the period's end, each with
//                       the changes in the period; one node, no aggregate, no as-of, no
//                       node period. Answered from the Warehouse or refused.
//
// Values never live in the plan. A filter's value is { param: 'p1' }, and the values go
// alongside as parameters (planParameters): the stored structure (ontology.compiled_manifests)
// carries placeholders only, so a plan can be kept, hashed and shared without holding a
// record value. A period is the asker's own words plus a typed expression (calendar,
// trailing, to_date, or between two parameters), resolved to an absolute half-open range
// against the organisation's calendar each time the plan runs (spec 26.8), never stored
// resolved.
//
// The three outcomes (spec 26.9) are finished replies, not errors: an answer, a refusal
// naming the element, bound or capability, and a clarification among named options.

import { z } from 'zod';
import { FILTER_OPS } from '../connect/manifest.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

export const PLAN_SCHEMA_VERSION = '1';

/** At most this many hops in one compiled question (spec 26 open decision): beyond it, refused. */
export const MAX_HOPS = 4;
/** More hops than this make a compile advanced (spec 26.10, 73). */
export const ADVANCED_HOPS = 2;

const alias = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'lower snake case');
const scalar = z.union([z.string().max(4_096), z.number().finite(), z.boolean()]);

/** A placeholder for a value supplied in the parameters. */
export const paramRef = z.strictObject({ param: z.string().regex(/^p[0-9]{1,3}$/) });
export type ParamRef = z.infer<typeof paramRef>;

/** The values a plan's placeholders stand for. Record values: never stored with the plan. */
export const planParameters = z.record(z.string().regex(/^p[0-9]{1,3}$/), z.union([scalar, z.array(scalar).min(1).max(1_000)]));
export type PlanParameters = z.infer<typeof planParameters>;

export const planFilter = z.strictObject({
  /** A property identity id of the node's object type. */
  property: z.uuid(),
  op: z.enum(FILTER_OPS),
  /** Absent for is_null and is_not_null; a list parameter for in. */
  value: paramRef.optional(),
}).refine((f) => (f.op === 'is_null' || f.op === 'is_not_null') === (f.value === undefined),
  'a null check has no value; every other operator has one');
export type PlanFilter = z.infer<typeof planFilter>;

export const CALENDAR_UNITS = ['day', 'week', 'month', 'quarter', 'year', 'financial_quarter', 'financial_year'] as const;
export const TRAILING_UNITS = ['day', 'week', 'month', 'year'] as const;
export const TO_DATE_UNITS = ['week', 'month', 'quarter', 'year', 'financial_quarter', 'financial_year'] as const;

export const periodExpression = z.discriminatedUnion('kind', [
  /** A whole calendar period: offset 0 is this one, -1 the last, 1 the next ("last quarter": quarter, -1). */
  z.strictObject({ kind: z.literal('calendar'), unit: z.enum(CALENDAR_UNITS), offset: z.int().min(-120).max(120) }),
  /** Ending now: "the past year" is twelve months ending now, not one day (spec 26.8). */
  z.strictObject({ kind: z.literal('trailing'), unit: z.enum(TRAILING_UNITS), count: z.int().min(1).max(3_660) }),
  /** From the start of the current period to now ("year to date"). */
  z.strictObject({ kind: z.literal('to_date'), unit: z.enum(TO_DATE_UNITS) }),
  /** Between two dates the asker named, as parameters: from inclusive, to exclusive. */
  z.strictObject({ kind: z.literal('between'), from: paramRef, to: paramRef }),
]);
export type PeriodExpression = z.infer<typeof periodExpression>;

export const planPeriod = z.strictObject({
  /** A declared time field of the node's object type (its property identity id). */
  property: z.uuid(),
  expression: periodExpression,
  /** The asker's words ("last quarter"), shown back with the resolution; never parsed. */
  asWritten: z.string().trim().min(1).max(200),
});
export type PlanPeriod = z.infer<typeof planPeriod>;

/**
 * "As of" an instant (spec 69.6): the instant a parameter (a date and time with its offset, or a
 * date, which is the end of that day in the organisation's calendar), with the asker's words.
 */
export const planAsOf = z.strictObject({
  at: paramRef,
  asWritten: z.string().trim().min(1).max(200),
});
export type PlanAsOf = z.infer<typeof planAsOf>;

/** "How did ... change over" a period (spec 69.16): the period, with the asker's words shown back. */
export const planHistory = z.strictObject({
  expression: periodExpression,
  asWritten: z.string().trim().min(1).max(200),
});
export type PlanHistory = z.infer<typeof planHistory>;

export const planNode = z.strictObject({
  /** The node's object type; or, at the root of a plan with no hops, an interface (below). */
  objectTypeId: z.uuid().optional(),
  /**
   * The root over an interface (spec 21.9): expanded to one sub-plan per implementing type the
   * reader may see. The plan's filters, period, selections, groups, measures and sorts then name
   * the interface's required shared properties, and the answer states which types contributed.
   */
  interfaceId: z.uuid().optional(),
  filters: z.array(planFilter).max(20).default([]),
  period: planPeriod.optional(),
  /**
   * A linked node the parent must reach (spec 37.8's traversals): the parent keeps only the objects
   * linked to one here, as a filtered node narrows it, even with no filter of its own. Not on the root.
   */
  required: z.boolean().optional(),
});
export type PlanNode = z.output<typeof planNode>;

export const planHop = z.strictObject({
  from: z.int().min(0).max(7),
  to: z.int().min(1).max(7),
  linkTypeId: z.uuid(),
  routeId: z.uuid(),
});
export type PlanHop = z.infer<typeof planHop>;

export const nodeProperty = z.strictObject({ node: z.int().min(0).max(7), property: z.uuid() });
export type NodeProperty = z.infer<typeof nodeProperty>;

/**
 * A group key (spec 27.7, 37.8): a root property, or a date or time property grouped by the period
 * of a calendar unit containing it, in the organisation's calendar (a time series' buckets).
 */
export const planGroup = z.strictObject({ node: z.int().min(0).max(7), property: z.uuid(), bucket: z.enum(CALENDAR_UNITS).optional() });
export type PlanGroup = z.infer<typeof planGroup>;

export const MEASURE_FUNCTIONS = ['count', 'sum', 'min', 'max', 'avg', 'count_distinct'] as const;
export type MeasureFunction = (typeof MEASURE_FUNCTIONS)[number];

export const planMeasure = z.strictObject({
  fn: z.enum(MEASURE_FUNCTIONS),
  node: z.int().min(0).max(7),
  /** Absent only for count, which counts objects. */
  property: z.uuid().optional(),
  as: alias,
}).refine((m) => m.fn === 'count' || m.property !== undefined, 'every measure but count names a property');
export type PlanMeasure = z.infer<typeof planMeasure>;

export const planSort = z.strictObject({
  /** A root property (node 0) or, with an aggregate, a group key. */
  property: z.uuid().optional(),
  /** A measure's alias, with an aggregate. */
  measure: alias.optional(),
  direction: z.enum(['asc', 'desc']),
}).refine((s) => (s.property === undefined) !== (s.measure === undefined), 'a sort names a property or a measure');
export type PlanSort = z.infer<typeof planSort>;

export const queryPlan = z.strictObject({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION),
  ontologyVersionId: z.uuid(),
  nodes: z.array(planNode).min(1).max(8),
  hops: z.array(planHop).max(7).default([]),
  select: z.array(nodeProperty).max(200).default([]),
  aggregate: z.strictObject({
    groupBy: z.array(planGroup).max(5).default([]),
    measures: z.array(planMeasure).min(1).max(20),
  }).optional(),
  sort: z.array(planSort).max(5).default([]),
  limit: z.int().min(1).max(100_000).optional(),
  asOf: planAsOf.optional(),
  history: planHistory.optional(),
}).superRefine((plan, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (plan.history !== undefined) {
    if (plan.nodes.length !== 1) issue(['history'], 'a history question reads one object type');
    if (plan.aggregate !== undefined) issue(['history'], 'a history question lists changes, not aggregates');
    if (plan.asOf !== undefined) issue(['history'], 'a history question has a period, not an instant');
    if (plan.nodes.some((n) => n.period !== undefined)) issue(['history'], 'a history question\'s period is its own');
    if (!plan.select.some((s) => s.node === 0)) issue(['history'], 'a history question names the properties whose changes it lists');
  }
  if (plan.asOf !== undefined) {
    if (plan.nodes.length !== 1) issue(['asOf'], 'an as-of question reads one object type');
    if (plan.aggregate !== undefined) issue(['asOf'], 'an as-of question is not aggregated');
    if (plan.nodes.some((n) => n.period !== undefined)) issue(['asOf'], 'an as-of question has no period');
  }
  plan.nodes.forEach((n, i) => {
    if ((n.objectTypeId === undefined) === (n.interfaceId === undefined)) issue(['nodes', i], 'a node names an object type or an interface');
    else if (n.interfaceId !== undefined && i > 0) issue(['nodes', i, 'interfaceId'], 'only the root names an interface');
    if (n.required === true && i === 0) issue(['nodes', 0, 'required'], 'the root has no parent to narrow');
  });
  if (plan.nodes[0]?.interfaceId !== undefined) {
    if (plan.hops.length > 0) issue(['hops'], 'a plan over an interface has no hops: links join types, not interfaces');
    if (plan.asOf !== undefined || plan.history !== undefined) issue(['nodes', 0, 'interfaceId'], 'as-of and history questions read one object type');
  }
  // The hops form a tree rooted at node 0: every other node is reached by exactly one hop,
  // from an earlier node.
  const reached = new Set<number>([0]);
  plan.hops.forEach((hop, i) => {
    if (hop.to >= plan.nodes.length || hop.from >= plan.nodes.length) issue(['hops', i], 'a hop names a node the plan does not have');
    else if (hop.from >= hop.to) issue(['hops', i], 'a hop goes from an earlier node to a later one');
    else if (reached.has(hop.to)) issue(['hops', i, 'to'], 'each node is reached by one hop');
    else if (!reached.has(hop.from)) issue(['hops', i, 'from'], 'a hop starts from a node already reached');
    reached.add(hop.to);
  });
  if (plan.hops.length !== plan.nodes.length - 1) issue(['hops'], 'every node but the root is reached by exactly one hop');
  const node = (n: number, path: (string | number)[]) => { if (n >= plan.nodes.length) issue(path, 'no such node'); };
  plan.select.forEach((s, i) => node(s.node, ['select', i, 'node']));
  if (plan.aggregate !== undefined) {
    plan.aggregate.groupBy.forEach((g, i) => { if (g.node !== 0) issue(['aggregate', 'groupBy', i, 'node'], 'groups are root properties'); });
    const names = new Set<string>();
    plan.aggregate.measures.forEach((m, i) => {
      node(m.node, ['aggregate', 'measures', i, 'node']);
      if (names.has(m.as)) issue(['aggregate', 'measures', i, 'as'], 'measure names are unique');
      names.add(m.as);
    });
    plan.sort.forEach((s, i) => {
      if (s.measure !== undefined && !names.has(s.measure)) issue(['sort', i, 'measure'], 'no such measure');
      if (s.property !== undefined && !plan.aggregate!.groupBy.some((g) => g.property === s.property)) {
        issue(['sort', i, 'property'], 'with an aggregate, a sort names a group key or a measure');
      }
    });
  } else {
    plan.sort.forEach((s, i) => { if (s.measure !== undefined) issue(['sort', i, 'measure'], 'a measure sorts only with an aggregate'); });
  }
});
export type QueryPlan = z.output<typeof queryPlan>;
export type QueryPlanInput = z.input<typeof queryPlan>;

// ----------------------------------------------------------------------------- outcomes

/** What a refusal names (spec 26.9): the element, the bound or the capability. */
export const refusal = z.object({
  code: z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z0-9_]*)+$/),
  /** A sentence for the asker. It names elements and bounds, never a value. */
  reason: z.string().max(1_000),
  element: z.object({
    kind: z.enum(['object_type', 'property', 'link_type', 'route', 'connection', 'time_field', 'function', 'calendar', 'parameter', 'plan', 'interface']),
    id: z.string().max(100).optional(),
    name: z.string().max(200).optional(),
  }).optional(),
  bound: z.object({
    name: z.string().max(100),
    limit: z.number(),
    /** The count, where the source can count. */
    observed: z.number().optional(),
    connectionId: z.uuid().optional(),
  }).optional(),
  /** What would make it answerable, where that is knowable. */
  remedy: z.string().max(500).optional(),
});
export type Refusal = z.infer<typeof refusal>;

/** A choice among named alternatives (spec 26.9): never a guess. */
export const clarification = z.object({
  about: z.enum(['object_type', 'time_field', 'route', 'property']),
  question: z.string().max(500),
  options: z.array(z.object({ id: z.uuid(), name: z.string().max(200) })).min(2).max(20),
});
export type Clarification = z.infer<typeof clarification>;

// ----------------------------------------------------------------------------- explanation

/** How the planner decomposed a plan, and the bounds it runs under (spec 26.10, 27.2). */
export const planExplanation = z.object({
  nodes: z.array(z.object({
    node: z.int(),
    objectTypeId: z.uuid(),
    /** single_source: filters pushed to the one system. merged: every contributing system read within its bound, filtered after merge. */
    mode: z.enum(['single_source', 'merged']),
    sources: z.array(z.object({
      connectionId: z.uuid(),
      sourceObject: z.string(),
      fields: z.array(z.string()),
      /** Filters the source applies. */
      nativeFilters: z.int(),
      /** Filters applied in the engine after a bounded read, each exact for its operator (spec 27.3). */
      localFilters: z.array(z.object({ field: z.string(), op: z.enum(FILTER_OPS) })),
    })),
  })),
  hops: z.array(z.object({ hop: z.int(), linkTypeId: z.uuid(), routeId: z.uuid(), leads: z.enum(['from', 'to']) })),
  bounds: z.object({
    rowsPerSource: z.int(),
    keysPerHop: z.int(),
    mergedResult: z.int(),
    wallTimeMs: z.int(),
  }),
  periods: z.array(z.object({
    node: z.int(),
    property: z.uuid(),
    asWritten: z.string(),
    from: z.string(),
    to: z.string(),
  })),
  /** A large aggregate the Warehouse computes, as of its watermark (69.6). */
  aggregate: z.object({ source: z.literal('warehouse'), watermark: z.string(), reason: z.string() }).optional(),
  /** Planned against an ontology branch, not main (spec 25.3). */
  branch: z.object({ branchId: z.uuid(), kind: z.enum(['working', 'derivation', 'scenario']) }).optional(),
  /** A plan over an interface (21.9): the implementing types it expands to that the reader may see, one node each. */
  interface: z.object({ interfaceId: z.uuid(), objectTypeIds: z.array(z.uuid()) }).optional(),
  /** An as-of question: the instant, and the Warehouse that answers it (69.6). */
  asOf: z.object({ asWritten: z.string(), at: z.string(), source: z.literal('warehouse'), watermark: z.string() }).optional(),
  /** A history question: the period resolved, and the Warehouse that answers it (69.16). */
  history: z.object({ asWritten: z.string(), from: z.string(), to: z.string(), source: z.literal('warehouse'), watermark: z.string() }).optional(),
});
export type PlanExplanation = z.infer<typeof planExplanation>;

const purposeSessionIds = z.array(z.uuid()).max(16);

/** The services that run or store plans. */
export const PLAN_READERS = ['compile', 'executor', 'ask', 'workspace', 'studio', 'scheduler', 'recognition', 'simulation', 'state-plane'] as const;

/**
 * The bounds stage (spec 26.10): decompose a plan against the reader's access now, check
 * every filter is one each contributing system applies or applies exactly after a bounded
 * read, and state the bounds it will run under. Nothing is read from any source.
 */
export const explainPlan = defineContract({
  service: 'planner', name: 'explainPlan', method: 'POST', path: '/v1/plans/explanations',
  callers: PLAN_READERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ plan: queryPlan, parameters: planParameters.default({}), purposeSessionIds: purposeSessionIds.optional() }),
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('plan'), explanation: planExplanation }),
    z.object({ outcome: z.literal('refusal'), refusal }),
  ]),
  maxBodyBytes: 256 * 1024,
});
