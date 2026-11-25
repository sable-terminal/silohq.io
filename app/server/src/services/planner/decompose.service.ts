// Decompose (spec 26.7, 27.2, 27.3): a plan over ontology ids becomes source steps per
// contributing object, in each system's own field names, checked against what the reader
// may see now and what each system can do.
//
// - Referential truth, again: every type, property, link and route the plan names must be in
//   the reader's vocabulary now (access changes between compile and run). A masked or
//   redacted property is shown but never filtered, sorted, grouped or measured: an answer
//   that moves with a hidden value discloses it.
// - Field selection reads only the mapped fields the plan uses, so nothing else reaches the
//   source system (27.2).
// - A single-source type has its filters pushed to its system; what the system cannot do
//   (pushdown-compiler says, after conformance) is applied in the engine after a bounded
//   read, only where that is exact for the operator and type: equality and null checks on
//   strings, numbers, booleans and dates, ranges on numbers and dates. Anything else is
//   refused, naming the property and the connection (26.6, 27.3). Coded fields (value maps)
//   and local-time fields are compared in the engine on their decided values.
// - A resolvable type with several systems: until the entity graph exists, an object's
//   membership of a filtered population is only decided once all its records are merged
//   (one system could hold a different value: a dispute). So each system is read whole,
//   within its bound, and the filters apply after merge on decided values; a filter that
//   falls on a disputed value excludes the object and is counted.
// - A hop pairs objects on the route's key: the foreign key in the route's source object
//   and the referenced field on the other end, in the route's connection. The filtered side
//   leads a single hop (26.11); a bounded key set then reads the other side by identity.

import { chooseSource } from './sourceChoice.service.ts';
import { objectIndexCoverage } from '../../contracts/index-builder/index.contract.ts';
import { warehouseCoverage } from '../../contracts/warehouse/read.contract.ts';
import { manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import { connectionRepo, connectorManifestRepo } from '../../repos/connect/index.repo.ts';
import type { StepAggregate } from '../../contracts/connect/step.contract.ts';
import { FILTER_OPS, type FilterOp } from '../../contracts/connect/manifest.contract.ts';
import type { StepFilter } from '../../contracts/connect/step.contract.ts';
import type { PeriodResolution } from '../../contracts/executor/result.contract.ts';
import type { DataType, LinkTypeView, ObjectTypeView, OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import {
  MAX_HOPS, type MeasureFunction, type PlanExplanation, type PlanParameters, type QueryPlan, type Refusal,
} from '../../contracts/planner/plan.contract.ts';
import { checkSourcePartition } from '../../contracts/resolution/resolve.contract.ts';
import { explainPushdown } from '../../contracts/pushdown-compiler/pushdown.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import {
  isRefusal, readerAccess, type ContributingObjectView, type LinkAccess, type LinkRouteView, type PropertyAccess, type ReaderAccess, type TypeAccess,
} from './access.service.ts';
import { callOptions, type PlanCall, type PlannerDeps } from './deps.service.ts';
import { manifestOf } from './manifests.service.ts';
import { resolvePeriod, startOfDay, type Calendar, endOfDate } from './period.service.ts';

export type Scalar = string | number | boolean;
export type FilterValue = Scalar | Scalar[] | undefined;

/** A filter in property terms, applied by the engine on decided values. */
export interface NodeFilter {
  property: PropertyAccess;
  op: FilterOp;
  value: FilterValue;
  /** A period's end, compared as an instant (timestamp) or a calendar date (date). */
  period?: boolean;
}

export interface SourceStep {
  node: number;
  source: ContributingObjectView;
  /** Manifest field names read. */
  fields: string[];
  /** Filters the source applies (pushed down), in the source's field names. */
  native: StepFilter[];
  /** Filters applied in the engine after the bounded read, for the explanation and the answer. */
  local: { field: string; op: FilterOp }[];
}

export interface NodeProgram {
  node: number;
  access: TypeAccess;
  mode: 'single_source' | 'merged';
  sources: SourceStep[];
  /** Applied by the engine on decided values: residual filters (single source) or every filter (merged). */
  filters: NodeFilter[];
  period: PeriodResolution | undefined;
  /** The node narrows its parent: it has filters or a period. */
  restricted: boolean;
  /** Property identity ids the node reads. */
  reads: Set<string>;
  /** Added to read a computed property's linked objects (21.11): never shown, never narrowing. */
  hidden?: boolean | undefined;
  /** For each link a computed property of this node reads: the hidden hop that reads it. */
  linkedHops?: Map<string, number> | undefined;
  /**
   * The Object Index answers this node (spec 69.6; decision 2026-11-14): the chooser's reason,
   * the index's watermark, and the read. The executor falls back to the sources where the
   * index declines at run time.
   */
  index?: IndexAnswer | undefined;
  /** A split plan (69.6): the Object Index gives the keys, the system is read live for them. */
  split?: SplitAnswer | undefined;
  /**
   * The Warehouse answers this node as of an instant (69.6): rebuilt from its history, with
   * no live fallback (no system holds the past). Set only for an as-of plan.
   */
  warehouse?: WarehouseAnswer | undefined;
}

export interface WarehouseAnswer {
  at: string;
  watermark: string;
  reason: string;
  properties: string[];
  filters: { property: string; op: IndexOp; value?: FilterValue }[];
}

export interface IndexAnswer {
  refreshedAt: string;
  reason: string;
  properties: string[];
  filters: { property: string; op: IndexOp; value?: FilterValue }[];
}

type IndexOp = 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'is_null' | 'not_null';
const INDEX_OPS: Partial<Record<FilterOp, IndexOp>> = {
  eq: 'eq', ne: 'neq', lt: 'lt', lte: 'lte', gt: 'gt', gte: 'gte', in: 'in', is_null: 'is_null', is_not_null: 'not_null',
};

/**
 * Whether the Object Index answers a node (69.6): a single-source type (the index holds a
 * disputed value as empty, so a type several systems feed is read live), every filter one
 * the index applies, a refreshed nomination holding every property used, and the chooser
 * picking it over live (fresh within the tolerance). Anything else, or the index
 * unreachable, reads live.
 */
interface IndexHeld { objectTypeId: string; held: string[]; refreshedAt: string }

/**
 * What a fresh Object Index holds of a type, where the planner may use it at all. A type
 * several systems feed is answered from it too: the index records disputes, and a read from
 * a refresh that did not declines, so the type is read live.
 */
async function indexHeldFor(deps: PlannerDeps, call: PlanCall, node: NodeProgram, filters: readonly NodeFilter[]): Promise<IndexHeld | undefined> {
  if (filters.some((f) => INDEX_OPS[f.op] === undefined || f.period === true)) return undefined;
  try {
    const coverage = await deps.services.call(objectIndexCoverage, { body: { objectTypeIds: [node.access.type.id] } }, callOptions(call));
    return coverage.types.find((t) => t.objectTypeId === node.access.type.id);
  } catch {
    return undefined;
  }
}

function indexAnswer(plan: QueryPlan, node: NodeProgram, filters: readonly NodeFilter[], held: IndexHeld, toleranceSeconds: number | undefined): IndexAnswer | undefined {
  // What the plan uses (an entry is already merged, so the match keys only where asked for).
  const properties = usedProperties(plan, node, filters);
  const choice = chooseSource({ shape: filters.length > 0 ? 'filter' : 'lookup', properties, timeRange: null, asOf: null, largeSet: false, toleranceSeconds }, [
    { kind: 'live', holds: new Set(properties), history: null, watermark: null, estimatedCost: node.sources.length * 100 },
    { kind: 'index', holds: new Set(held.held), history: null, watermark: held.refreshedAt, estimatedCost: 1 },
  ]);
  if (choice.kind !== 'index') return undefined;
  return {
    refreshedAt: held.refreshedAt, reason: choice.reason, properties: properties.filter((id) => node.reads.has(id)),
    filters: filters.map((f) => ({ property: f.property.property.identityId, op: INDEX_OPS[f.op]!, value: f.value })),
  };
}

/**
 * A split plan (69.6; decision 2026-11-14): the Object Index decides which objects meet the
 * filters, and the system is read live by key for them. Used where the system cannot apply
 * some filter itself (it would be read whole within its bound and filtered after), the index
 * holds every filtered property and the type's identifier and is fresh within the tolerance,
 * and the system applies `in` on the identifier. The filters are applied again to the live
 * values, so an object that has stopped meeting them since the refresh is left out; one that
 * has started is missed until the next refresh, and the answer says the set is as of then.
 */
export interface SplitAnswer {
  refreshedAt: string;
  reason: string;
  /** The identifier's property identity id, and the system's field it is read by. */
  identifier: string;
  field: string;
  filters: { property: string; op: IndexOp; value?: FilterValue }[];
}

async function splitAnswer(deps: PlannerDeps, call: PlanCall, node: NodeProgram, filters: readonly NodeFilter[], held: IndexHeld,
  toleranceSeconds: number | undefined): Promise<SplitAnswer | undefined> {
  // Read by key on one system: a type several systems feed is merged from all of them.
  if (node.mode !== 'single_source') return undefined;
  const step = node.sources[0]!;
  if (filters.length === 0 || step.local.length === 0) return undefined;
  const identifier = [...node.access.properties.values()].find((p) => {
    const m = mappingIn(p, step.source);
    return p.effect === 'allow' && p.computed === undefined && m !== undefined && m.fieldPath === step.source.identifierFieldPath && m.valueMap === null && m.sourceTimeZone === null;
  });
  if (identifier === undefined) return undefined;
  const properties = [identifier.property.identityId, ...filters.map((f) => f.property.property.identityId)];
  const choice = chooseSource({ shape: 'filter', properties, timeRange: null, asOf: null, largeSet: false, toleranceSeconds }, [
    { kind: 'live', holds: new Set(properties), history: null, watermark: null, estimatedCost: 100 },
    { kind: 'index', holds: new Set(held.held), history: null, watermark: held.refreshedAt, estimatedCost: 1 },
  ]);
  if (choice.kind !== 'index') return undefined;
  // The system must take the keys itself, or reading by key costs what reading it whole does.
  const sample = identifier.property.dataType === 'integer' || identifier.property.dataType === 'decimal' ? 0 : 'x';
  const byKey = { field: step.source.identifierFieldPath, op: 'in', value: [sample] } as StepFilter;
  let explained;
  try {
    explained = await deps.services.call(explainPushdown, {
      body: { connectionId: step.source.connectionId, step: { object: step.source.sourceObject, fields: step.fields, filters: [...step.native, byKey] } },
    }, callOptions(call));
  } catch {
    return undefined;
  }
  if (!explained.split.native.filters.some((f) => canonicalJson(f) === canonicalJson(byKey))) return undefined;
  return {
    refreshedAt: held.refreshedAt, reason: 'the set from the Object Index, where the system cannot apply the filters; values read live by key',
    identifier: identifier.property.identityId, field: step.source.identifierFieldPath,
    filters: filters.map((f) => ({ property: f.property.property.identityId, op: INDEX_OPS[f.op]!, value: f.value })),
  };
}

/** What the plan uses of a node: its reads less the match keys merging adds, unless asked for, and every filtered property. */
function usedProperties(plan: QueryPlan, node: NodeProgram, filters: readonly NodeFilter[]): string[] {
  const keys = new Set(node.access.type.matchKeys.map((k) => k.propertyIdentityId));
  const asked = new Set<string>([...plan.select.filter((s) => s.node === 0).map((s) => s.property),
    ...plan.sort.flatMap((s) => (s.property === undefined ? [] : [s.property])), ...filters.map((f) => f.property.property.identityId)]);
  return [...new Set([...[...node.reads].filter((id) => !keys.has(id) || asked.has(id)), ...filters.map((f) => f.property.property.identityId)])];
}

/**
 * The Warehouse's answer to an as-of node (69.6), or a refusal: no other source holds the
 * past. Every filter one the Warehouse applies, every property used held by its nomination,
 * and its history reaching back to the instant and its watermark reaching up to it.
 */
async function warehouseAnswer(deps: PlannerDeps, call: PlanCall, plan: QueryPlan, node: NodeProgram, filters: readonly NodeFilter[], at: string)
  : Promise<WarehouseAnswer | Refusal> {
  const type = node.access.type;
  const element = { kind: 'object_type' as const, id: type.id, name: type.apiName };
  const unsupported = filters.find((f) => INDEX_OPS[f.op] === undefined);
  if (unsupported !== undefined) {
    return refuse('plan.as_of_filter', `an as-of question cannot apply ${unsupported.op} on ${unsupported.property.property.apiName}`, { element: propertyElement(unsupported.property) });
  }
  let coverage: { types: { objectTypeId: string; held: string[]; watermark: string; historyFrom: string }[] };
  try {
    coverage = await deps.services.call(warehouseCoverage, { body: { objectTypeIds: [type.id] } }, callOptions(call));
  } catch {
    return refuse('plan.as_of_unavailable', 'the Warehouse that holds history could not be reached', { element });
  }
  const held = coverage.types.find((t) => t.objectTypeId === type.id);
  if (held === undefined) {
    return refuse('plan.as_of_unavailable', `${type.apiName} is not held in a Warehouse, so its past is not known`, {
      element, remedy: 'nominate the object type to the Warehouse; its history starts then',
    });
  }
  const properties = usedProperties(plan, node, filters);
  const choice = chooseSource({ shape: filters.length > 0 ? 'filter' : 'lookup', properties, timeRange: null, asOf: at, largeSet: false }, [
    { kind: 'live', holds: new Set(properties), history: null, watermark: null, estimatedCost: node.sources.length * 100 },
    { kind: 'warehouse', holds: new Set(held.held), history: { from: held.historyFrom, to: null }, watermark: held.watermark, estimatedCost: 10 },
  ]);
  if (choice.kind !== 'warehouse') {
    const passed = choice.passedOver.find((x) => x.kind === 'warehouse');
    if (passed?.reason === 'coverage') {
      const missing = node.access.properties.get(passed.missing[0]!);
      return refuse('plan.as_of_unavailable', `the Warehouse does not hold ${missing?.property.apiName ?? 'a property asked for'} of ${type.apiName}`, {
        element: missing === undefined ? element : propertyElement(missing), remedy: 'nominate the property to the Warehouse; its history starts then',
      });
    }
    const before = Date.parse(at) < Date.parse(held.historyFrom);
    return refuse('plan.as_of_unavailable', before
      ? `the Warehouse holds ${type.apiName}'s history from ${held.historyFrom}, after the instant asked about`
      : `the Warehouse holds ${type.apiName} up to ${held.watermark}, before the instant asked about`, { element });
  }
  return {
    at, watermark: held.watermark, reason: choice.reason, properties: properties.filter((id) => node.reads.has(id)),
    filters: filters.map((f) => ({ property: f.property.property.identityId, op: INDEX_OPS[f.op]!, value: f.value })),
  };
}

/**
 * A large aggregate the Warehouse computes (69.6): current state as of its watermark, every
 * filter of the node (its period's included) applied there, with the engine's rules for
 * disputes. The executor reads the sources where the Warehouse declines at run time.
 */
export interface WarehouseAggregate {
  watermark: string;
  reason: string;
  groupBy: string[];
  measures: { as: string; fn: MeasureFunction; property?: string | undefined; node: 0 | 1 }[];
  filters: { property: string; op: IndexOp; value?: FilterValue }[];
  /** Across one link (D116): its link type, the type at its far end, and whether the root is its to side. */
  hop?: { linkTypeId: string; objectTypeId: string; reverse: boolean } | undefined;
}

/**
 * Whether the Warehouse computes a single-type aggregate (69.6): no source computes it per
 * group, every filter one the Warehouse applies, nothing computed by Silo, every property held,
 * a set larger than one source read may hold (by the Warehouse's row count), and fresh within
 * the tolerance. Anything else reads the sources.
 */
async function warehouseAggregateOf(deps: PlannerDeps, call: PlanCall, plan: QueryPlan, node: NodeProgram, filters: readonly NodeFilter[],
  toleranceSeconds: number | undefined, across?: { hop: HopProgram; target: NodeProgram } | undefined): Promise<WarehouseAggregate | undefined> {
  const aggregate = plan.aggregate!;
  if (filters.some((f) => INDEX_OPS[f.op] === undefined)) return undefined;
  const near = aggregate.measures.filter((m) => m.node === 0);
  const far = aggregate.measures.filter((m) => m.node === 1);
  if (near.length + far.length !== aggregate.measures.length || (far.length > 0 && across === undefined)) return undefined;
  const used = [...new Set([...aggregate.groupBy.map((g) => g.property), ...near.flatMap((m) => (m.property === undefined ? [] : [m.property])),
    ...filters.map((f) => f.property.property.identityId)])];
  const farUsed = [...new Set(far.flatMap((m) => (m.property === undefined ? [] : [m.property])))];
  if (used.some((id) => node.access.properties.get(id)?.computed !== undefined)) return undefined;
  if (across !== undefined && farUsed.some((id) => across.target.access.properties.get(id)?.computed !== undefined)) return undefined;
  const typeIds = [node.access.type.id, ...(across === undefined ? [] : [across.target.access.type.id])];
  let coverage: { types: { objectTypeId: string; held: string[]; watermark: string; rowCount: number }[]; links?: { linkTypeId: string; watermark: string }[] | undefined };
  try {
    coverage = await deps.services.call(warehouseCoverage, {
      body: { objectTypeIds: typeIds, ...(across === undefined ? {} : { linkTypeIds: [across.hop.link.id] }) },
    }, callOptions(call));
  } catch {
    return undefined;
  }
  const held = coverage.types.find((t) => t.objectTypeId === node.access.type.id);
  if (held === undefined) return undefined;
  const farHeld = across === undefined ? undefined : coverage.types.find((t) => t.objectTypeId === across.target.access.type.id);
  const link = across === undefined ? undefined : coverage.links?.find((l) => l.linkTypeId === across.hop.link.id);
  if (across !== undefined && (farHeld === undefined || link === undefined)) return undefined;
  // The Warehouse's answer is as old as the oldest table it reads.
  const watermark = [held.watermark, farHeld?.watermark, link?.watermark].filter((w): w is string => w !== undefined)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
  const largeSet = Math.max(held.rowCount, farHeld?.rowCount ?? 0) > deps.bounds.maxRowsPerSourceStep;
  const holds = new Set([...held.held, ...(farHeld?.held ?? [])]);
  const choice = chooseSource({ shape: 'aggregate', properties: [...used, ...farUsed], timeRange: null, asOf: null, largeSet, toleranceSeconds }, [
    { kind: 'live', holds: new Set([...used, ...farUsed]), history: null, watermark: null, estimatedCost: node.sources.length * 100 },
    { kind: 'warehouse', holds, history: null, watermark, estimatedCost: 10 },
  ]);
  if (choice.kind !== 'warehouse') return undefined;
  return {
    watermark, reason: across === undefined ? choice.reason : `${choice.reason}, across ${across.hop.link.apiName}`, groupBy: aggregate.groupBy.map((g) => g.property),
    measures: aggregate.measures.map((m) => ({ as: m.as, fn: m.fn, node: m.node === 1 ? 1 as const : 0 as const, ...(m.property === undefined ? {} : { property: m.property }) })),
    filters: filters.map((f) => ({ property: f.property.property.identityId, op: INDEX_OPS[f.op]!, value: f.value })),
    ...(across === undefined ? {} : {
      hop: { linkTypeId: across.hop.link.id, objectTypeId: across.target.access.type.id, reverse: across.hop.link.fromTypeId !== node.access.type.id },
    }),
  };
}

/**
 * A large aggregate across one link the Warehouse may compute (D116): one hop from the root,
 * along the link's default route (the Warehouse's link table holds that route), no junction,
 * nothing filtered on the far side, grouped by root properties.
 */
function acrossOf(plan: QueryPlan, nodes: readonly NodeProgram[], hops: readonly HopProgram[], nodeFilters: readonly (readonly NodeFilter[])[])
  : { hop: HopProgram; target: NodeProgram } | undefined {
  if (hops.length !== 1 || nodes.length !== 2) return undefined;
  const hop = hops[0]!;
  const defaultRoute = hop.link.defaultRouteId ?? hop.link.routes[0]?.id;
  if (hop.from !== 0 || hop.to !== 1 || hop.junction !== undefined || hop.route.id !== defaultRoute) return undefined;
  if ((nodeFilters[1] ?? []).length > 0 || plan.aggregate!.groupBy.some((g) => g.node !== 0)) return undefined;
  return { hop, target: nodes[1]! };
}

export interface HopProgram {
  index: number;
  from: number;
  to: number;
  link: LinkTypeView;
  route: LinkRouteView;
  fromSource: ContributingObjectView;
  fromField: string;
  toSource: ContributingObjectView;
  toField: string;
  leads: 'from' | 'to';
  /** Reads a computed property's linked objects (21.11): followed, never shown. */
  hidden?: boolean | undefined;
  /**
   * A many-to-many route (spec 21.8): the junction object, in the route's connection, and its
   * key to each side. The hop reads the junction's pairs for the from side's keys, then the to
   * side by the keys they name.
   */
  junction?: { object: string; fromField: string; toField: string } | undefined;
}

/**
 * Partial aggregate pushdown (spec 27.7): the aggregate the source computes per group, and how
 * each of the plan's measures comes from its columns. Only for a single-source type whose
 * filters the source applies in full, with every measure splittable (sum, count, average,
 * minimum, maximum; a distinct count never is) over properties shown plainly and read as they
 * are stored, and only when the pushdown compiler says the source computes it natively.
 */
export interface AggregatePushdown {
  /**
   * One part a system: a single-source type's one; each contributing object of a resolvable type
   * declared disjoint and not contradicted by the entity graph (27.7), its filters pushed too.
   * Each part's groups are added to the others' by key.
   */
  parts: AggregatePart[];
  /** Each plan measure: the column holding it (avg: the sum) and the column counting its non-null values. */
  measures: { as: string; fn: 'count' | 'sum' | 'min' | 'max' | 'avg'; column: string; countColumn: string | null; property: PropertyAccess | null }[];
}

export interface AggregatePart {
  step: SourceStep;
  aggregate: StepAggregate;
  /** The filters this system applies (a single-source type's are already its step's). */
  filters: StepFilter[];
  /** The group key: the source field each key property is read from in this system. */
  groupBy: { field: string; property: PropertyAccess }[];
}

/** The rows of a group, counted by the source. */
export const GROUP_ROWS = 'g__rows';
const SPLITTABLE = new Set(['count', 'sum', 'min', 'max', 'avg']);

export interface Program {
  /** Set where the source computes the plan's aggregate per group (spec 27.7). */
  aggregatePushdown?: AggregatePushdown | undefined;
  plan: QueryPlan;
  parameters: PlanParameters;
  manifest: OntologyManifest;
  access: ReaderAccess;
  nodes: NodeProgram[];
  hops: HopProgram[];
  periods: PeriodResolution[];
  /** Set where the Warehouse computes the plan's large aggregate (69.6). */
  warehouseAggregate?: WarehouseAggregate | undefined;
  /** An as-of plan's instant, resolved (69.6). */
  asOf?: { at: string; asWritten: string } | undefined;
  /** A history plan's period, resolved, and the root properties whose changes it lists (69.16). */
  history?: { from: string; to: string; asWritten: string; properties: string[] } | undefined;
  calendar: Calendar;
  bounds: PlanExplanation['bounds'];
  defaults: { timeFields: { node: number; property: string }[]; routes: { hop: number; routeId: string }[] };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const NUMERIC: readonly DataType[] = ['integer', 'decimal'];
const COMPARABLE: readonly DataType[] = ['integer', 'decimal', 'date', 'timestamp', 'string'];
const FILTERABLE: readonly DataType[] = ['string', 'enum', 'integer', 'decimal', 'boolean', 'date', 'timestamp'];

/** Is the operator exact when the engine applies it to a bounded read of this type (spec 27.3)? */
export function exactLocally(op: FilterOp, type: DataType): boolean {
  if (op === 'is_null' || op === 'is_not_null') return true;
  if (op === 'contains' || op === 'starts_with') return false;
  if (op === 'eq' || op === 'ne' || op === 'in') return ['string', 'enum', 'integer', 'decimal', 'boolean', 'date', 'timestamp'].includes(type);
  return ['integer', 'decimal', 'date', 'timestamp'].includes(type);
}

const refuse = (code: string, reason: string, extra: Partial<Refusal> = {}): Refusal => ({ code, reason, ...extra });
const propertyElement = (p: PropertyAccess) => ({ kind: 'property' as const, id: p.property.identityId, name: p.property.apiName });

/** A parameter's value checked against the property's type; dates and instants as strings. */
function typedValue(p: PropertyAccess, op: FilterOp, value: unknown, calendar: Calendar): FilterValue | Refusal {
  const type = p.property.dataType;
  const one = (v: unknown): Scalar | Refusal => {
    const bad = refuse('plan.filter_value_type', `a value for ${p.property.apiName} is not a ${type}`, { element: propertyElement(p) });
    switch (type) {
      case 'integer': return typeof v === 'number' && Number.isInteger(v) ? v : bad;
      case 'decimal': return typeof v === 'number' ? v : bad;
      case 'boolean': return typeof v === 'boolean' ? v : bad;
      case 'date': return typeof v === 'string' && DATE.test(v) ? v : bad;
      case 'timestamp': {
        if (typeof v !== 'string') return bad;
        if (INSTANT.test(v)) return new Date(v).toISOString();
        const m = DATE.exec(v) ? v.split('-').map(Number) : undefined;
        return m ? startOfDay({ y: m[0]!, m: m[1]!, d: m[2]! }, calendar.timeZone) : bad;
      }
      default: return typeof v === 'string' ? v : bad;
    }
  };
  if (op === 'is_null' || op === 'is_not_null') return undefined;
  if (op === 'in') {
    if (!Array.isArray(value)) return refuse('plan.filter_value_type', `in on ${p.property.apiName} takes a list`, { element: propertyElement(p) });
    const out: Scalar[] = [];
    for (const v of value) {
      const t = one(v);
      if (typeof t === 'object') return t;
      out.push(t);
    }
    return out;
  }
  if (Array.isArray(value)) return refuse('plan.filter_value_type', `${op} on ${p.property.apiName} takes one value`, { element: propertyElement(p) });
  if ((op === 'contains' || op === 'starts_with') && type !== 'string') {
    return refuse('plan.filter_operator', `${op} applies to text, and ${p.property.apiName} is a ${type}`, { element: propertyElement(p) });
  }
  if (['lt', 'lte', 'gt', 'gte'].includes(op) && !COMPARABLE.includes(type)) {
    return refuse('plan.filter_operator', `${p.property.apiName} has no order to compare`, { element: propertyElement(p) });
  }
  return one(value);
}

async function calendarOf(deps: PlannerDeps, call: PlanCall): Promise<Calendar> {
  const organisationId = call.request.organisationId!;
  const row = await inTransaction(deps.databases.pool('control'), { organisationId }, (db) => organisationRepo.findById(db, organisationId),
    { readOnly: true });
  if (!row) throw new AppError('not_found', 'no such organisation', { code: 'plan.organisation_unknown' });
  return {
    timeZone: row.calendarTimeZone, financialYearStartMonth: row.financialYearStartMonth,
    financialYearStartDay: row.financialYearStartDay, weekStartDay: row.weekStartDay,
  };
}

/** The mapping of a property in one contributing object, if it has one. */
const mappingIn = (p: PropertyAccess, source: ContributingObjectView) =>
  p.property.mappings.find((m) => m.connectionId === source.connectionId && m.sourceObject === source.sourceObject);

export interface BuildOptions {
  /** The clock periods resolve against. */
  now?: number;
  /** False: read live only (a branch, a write's prior state). Default: the Object Index may answer (69.6). */
  index?: boolean;
  /** How stale an Object Index may be for this request, in seconds; default 15 minutes (69.6). */
  freshnessToleranceSeconds?: number;
  /**
   * An Explorer facet (34.1): a count by one property, or a range (min, max, count). Its
   * figures are presentation only, so a fresh Object Index may serve them (69.3); the binding
   * rule keeps the index from any aggregate that feeds an Action preview, which never runs as one.
   */
  facet?: boolean;
}

/** A facet's shape: counts by at most one property of the one node, or its range. */
const facetShaped = (plan: QueryPlan): boolean => plan.aggregate !== undefined && plan.hops.length === 0
  && plan.aggregate.groupBy.length <= 1 && plan.aggregate.groupBy.every((g) => g.node === 0 && g.bucket === undefined)
  && plan.aggregate.measures.every((m) => m.node === 0 && (m.fn === 'count' || m.fn === 'min' || m.fn === 'max'));

/**
 * The program for a plan, or a refusal naming what stops it. Reads the plan's own ontology
 * version and the reader's access now; asks pushdown-compiler what each system applies.
 */
export async function buildProgram(deps: PlannerDeps, call: PlanCall, plan: QueryPlan, parameters: PlanParameters, given: BuildOptions = {})
  : Promise<Program | Refusal> {
  let options = given;
  if (plan.hops.length > MAX_HOPS) {
    return refuse('plan.too_many_hops', `a question may traverse at most ${MAX_HOPS} links`, { bound: { name: 'hops', limit: MAX_HOPS, observed: plan.hops.length } });
  }
  const manifest = await manifestOf(deps, call, plan.ontologyVersionId);
  const access = await readerAccess(deps, call, manifest);
  // A plan on a branch reads live only (spec 25.3): the Object Index and the Warehouse hold main's objects.
  if (manifest.version.branchKind !== 'main') options = { ...options, index: false };
  if (isRefusal(access)) return access;
  const calendar = await calendarOf(deps, call);
  const now = options.now ?? Date.now();

  // Types and properties, as this reader may see them now.
  const nodeTypes: TypeAccess[] = [];
  for (const [i, node] of plan.nodes.entries()) {
    if (node.objectTypeId === undefined) {
      return refuse('plan.interface_root', 'a plan over an interface is expanded to its types before it is planned', { element: { kind: 'interface', id: node.interfaceId! } });
    }
    const type = access.types.get(node.objectTypeId);
    if (type === undefined) {
      return refuse('plan.object_type_unavailable', 'the plan names an object type that is not available to you', {
        element: { kind: 'object_type', id: node.objectTypeId }, ...(i === 0 ? {} : { remedy: 'ask without that link' }),
      });
    }
    nodeTypes.push(type);
  }
  const propertyOf = (node: number, id: string, use: 'shown' | 'computed'): PropertyAccess | Refusal => {
    const p = nodeTypes[node]!.properties.get(id);
    if (p === undefined) {
      return refuse('plan.property_unavailable', `${nodeTypes[node]!.type.apiName} has no property by that id that is available to you`, {
        element: { kind: 'property', id },
      });
    }
    if (use === 'computed' && p.effect !== 'allow') {
      return refuse('plan.property_not_computable', `${p.property.apiName} is ${p.effect === 'mask' ? 'masked' : 'redacted'} for you, so it is shown but not filtered, sorted, grouped or measured`,
        { element: propertyElement(p) });
    }
    return p;
  };

  const reads = plan.nodes.map(() => new Set<string>());
  const nodeFilters: NodeFilter[][] = plan.nodes.map(() => []);
  const periods: PeriodResolution[] = [];
  const defaults: Program['defaults'] = { timeFields: [], routes: [] };

  for (const [i, node] of plan.nodes.entries()) {
    for (const f of node.filters) {
      const p = propertyOf(i, f.property, 'computed');
      if (isRefusal(p)) return p;
      if (!FILTERABLE.includes(p.property.dataType)) {
        return refuse('plan.filter_type_unsupported', `${p.property.apiName} is a ${p.property.dataType}, which is not filtered yet`, { element: propertyElement(p) });
      }
      if (p.property.mappings.some((m) => m.valueMap !== null) && !['eq', 'ne', 'in', 'is_null', 'is_not_null'].includes(f.op)) {
        return refuse('plan.filter_operator', `${p.property.apiName} is a coded field; it is compared for equality only`, { element: propertyElement(p) });
      }
      let raw: unknown;
      if (f.value !== undefined) {
        if (!(f.value.param in parameters)) {
          return refuse('plan.parameter_missing', `the plan's value ${f.value.param} was not supplied`, { element: { kind: 'parameter', name: f.value.param } });
        }
        raw = parameters[f.value.param];
      }
      const value = typedValue(p, f.op, raw, calendar);
      if (isRefusal(value)) return value;
      nodeFilters[i]!.push({ property: p, op: f.op, value });
      reads[i]!.add(p.property.identityId);
    }
    if (node.period !== undefined) {
      const p = propertyOf(i, node.period.property, 'computed');
      if (isRefusal(p)) return p;
      const declared = nodeTypes[i]!.type.timeFields.find((t) => t.propertyIdentityId === node.period!.property);
      if (declared === undefined || (p.property.dataType !== 'date' && p.property.dataType !== 'timestamp')) {
        return refuse('plan.period_field', `${p.property.apiName} is not a declared time field of ${nodeTypes[i]!.type.apiName}`, {
          element: { kind: 'time_field', id: p.property.identityId, name: p.property.apiName },
        });
      }
      const basis = p.property.dataType === 'date' ? 'date' as const : 'timestamp' as const;
      const range = resolvePeriod(node.period.expression, basis, calendar, now, parameters);
      if (isRefusal(range)) return range;
      const resolution: PeriodResolution = {
        node: i, property: p.property.identityId, propertyApiName: p.property.apiName, asWritten: node.period.asWritten,
        from: range.from, to: range.to, basis, defaultTimeField: declared.isDefault, calendar,
      };
      periods.push(resolution);
      if (declared.isDefault) defaults.timeFields.push({ node: i, property: p.property.identityId });
      nodeFilters[i]!.push({ property: p, op: 'gte', value: range.from, period: true }, { property: p, op: 'lt', value: range.to, period: true });
      reads[i]!.add(p.property.identityId);
    }
  }

  for (const s of plan.select) {
    const p = propertyOf(s.node, s.property, 'shown');
    if (isRefusal(p)) return p;
    reads[s.node]!.add(p.property.identityId);
  }
  if (plan.aggregate !== undefined) {
    for (const g of plan.aggregate.groupBy) {
      const p = propertyOf(0, g.property, 'computed');
      if (isRefusal(p)) return p;
      if (g.bucket !== undefined) {
        // A time bucket (37.8): only a date or a time has periods, and a financial one needs the calendar's year.
        if (p.property.dataType !== 'date' && p.property.dataType !== 'timestamp') {
          return refuse('plan.bucket_type', `${p.property.apiName} is a ${p.property.dataType}, not a date or time, so it has no ${g.bucket.replace('_', ' ')}s to group by`, { element: propertyElement(p) });
        }
        if (g.bucket.startsWith('financial_') && calendar.financialYearStartMonth === null) {
          return refuse('plan.financial_year_unset', 'the organisation\'s calendar sets no financial year start, so financial periods cannot be grouped by',
            { element: { kind: 'calendar', name: 'financial_year_start_month' }, remedy: 'an administrator sets the financial year start in the organisation calendar' });
        }
      }
      reads[0]!.add(p.property.identityId);
    }
    for (const m of plan.aggregate.measures) {
      if (m.property === undefined) continue;
      const p = propertyOf(m.node, m.property, 'computed');
      if (isRefusal(p)) return p;
      if ((m.fn === 'sum' || m.fn === 'avg') && !NUMERIC.includes(p.property.dataType)) {
        return refuse('plan.measure_type', `${m.fn} needs a number, and ${p.property.apiName} is a ${p.property.dataType}`, { element: propertyElement(p) });
      }
      if ((m.fn === 'min' || m.fn === 'max') && !COMPARABLE.includes(p.property.dataType)) {
        return refuse('plan.measure_type', `${p.property.apiName} has no order to take a ${m.fn} of`, { element: propertyElement(p) });
      }
      reads[m.node]!.add(p.property.identityId);
    }
  }
  for (const s of plan.sort) {
    if (s.property === undefined) continue;
    const p = propertyOf(0, s.property, 'computed');
    if (isRefusal(p)) return p;
    reads[0]!.add(p.property.identityId);
  }

  // A hop's program: the right ends, and the key on each side.
  const planHop = async (index: number, from: number, to: number, link: LinkAccess, route: LinkRouteView): Promise<HopProgram | Refusal> => {
    const fromType = nodeTypes[from]!.type;
    const toType = nodeTypes[to]!.type;
    const forward = fromType.id === link.link.fromTypeId && toType.id === link.link.toTypeId;
    const reverse = fromType.id === link.link.toTypeId && toType.id === link.link.fromTypeId;
    if (!forward && !reverse) {
      return refuse('plan.link_ends', `${link.link.apiName} does not join ${fromType.apiName} to ${toType.apiName}`, { element: { kind: 'link_type', id: link.link.id, name: link.link.apiName } });
    }
    if (route.junctionObject !== null) {
      return junctionHop(deps, call, { index, from, to, link: link.link, route, fromType, toType });
    }
    const inConnection = (t: typeof fromType) => t.contributingObjects.filter((c) => c.connectionId === route.connectionId);
    const holdsKey = (t: typeof fromType) => inConnection(t).find((c) => c.sourceObject === route.sourceObject);
    // The foreign key lives in the route's source object; for a self link, on the far (many) side going forward.
    const fkOnFrom = fromType.id === toType.id ? reverse : holdsKey(fromType) !== undefined;
    const fkType = fkOnFrom ? fromType : toType;
    const refType = fkOnFrom ? toType : fromType;
    const fkSource = holdsKey(fkType);
    // The referenced end: the other type's object in the same system (for a self link, the same object),
    // or the one the route names in another system (D248: a component in one Silo, its specification in another).
    let refCandidates = route.referencedConnectionId != null
      ? refType.contributingObjects.filter((c) => c.connectionId === route.referencedConnectionId && c.sourceObject === route.referencedObject)
      : fromType.id === toType.id ? (fkSource === undefined ? [] : [fkSource]) : inConnection(refType);
    if (refCandidates.length > 1) refCandidates = refCandidates.filter((c) => c.sourceObject !== route.sourceObject);
    if (fkSource === undefined || refCandidates.length !== 1) {
      return refuse('plan.route_unusable', `the route of ${link.link.apiName} does not join the two types`, {
        element: { kind: 'route', id: route.id, name: link.link.apiName },
      });
    }
    const refSource = refCandidates[0]!;
    return {
      index, from, to, link: link.link, route,
      fromSource: fkOnFrom ? fkSource : refSource, fromField: fkOnFrom ? route.foreignKeyField : route.referencedField,
      toSource: fkOnFrom ? refSource : fkSource, toField: fkOnFrom ? route.referencedField : route.foreignKeyField,
      leads: 'from',
    };
  };

  // Hops: a visible link, a visible route, the right ends, and the key on each side.
  const hops: HopProgram[] = [];
  for (const [index, hop] of plan.hops.entries()) {
    const link = access.links.get(hop.linkTypeId);
    if (link === undefined) {
      return refuse('plan.link_type_unavailable', 'the plan names a link type that is not available to you', { element: { kind: 'link_type', id: hop.linkTypeId } });
    }
    const route = link.routes.find((r) => r.id === hop.routeId);
    if (route === undefined) {
      return refuse('plan.route_unavailable', `${link.link.apiName} has no route by that id that is available to you`, {
        element: { kind: 'route', id: hop.routeId, name: link.link.apiName },
      });
    }
    const planned = await planHop(index, hop.from, hop.to, link, route);
    if (isRefusal(planned)) return planned;
    hops.push(planned);
    if (link.link.defaultRouteId === route.id && link.routes.length > 1) defaults.routes.push({ hop: index, routeId: route.id });
  }

  // A computed property over links (21.11) reads its linked objects through a hidden hop from
  // its node for each link it reads (the link's default route, or its only one), selecting only
  // the linked properties it declares. Hidden hops are followed and never shown.
  const linkedHops = new Map<number, Map<string, number>>();
  const planNodeCount = nodeTypes.length;
  for (let i = 0; i < planNodeCount; i += 1) {
    for (const id of [...reads[i]!]) {
      for (const l of nodeTypes[i]!.properties.get(id)?.computed?.links ?? []) {
        const mine = linkedHops.get(i) ?? new Map<string, number>();
        linkedHops.set(i, mine);
        const at = mine.get(l.linkTypeId);
        if (at !== undefined) {
          for (const p of l.properties) reads[hops[at]!.to]!.add(p.identityId);
          continue;
        }
        const link = access.links.get(l.linkTypeId)!;
        const route = link.routes.find((r) => r.id === link.link.defaultRouteId) ?? (link.routes.length === 1 ? link.routes[0] : undefined);
        if (route === undefined) {
          return refuse('plan.route_needed', `${link.link.apiName} has several routes and no default, so the computed property over it cannot be read`, {
            element: { kind: 'link_type', id: link.link.id, name: link.link.apiName }, remedy: 'set the link\'s default route',
          });
        }
        if (hops.filter((h) => h.hidden).length >= MAX_HOPS) {
          return refuse('plan.too_many_hops', `the computed properties asked for read more than ${MAX_HOPS} links`, { bound: { name: 'hops', limit: MAX_HOPS } });
        }
        const node = nodeTypes.length;
        nodeTypes.push(access.types.get(l.otherTypeId)!);
        reads.push(new Set(l.properties.map((p) => p.identityId)));
        nodeFilters.push([]);
        const planned = await planHop(hops.length, i, node, link, route);
        if (isRefusal(planned)) return planned;
        hops.push({ ...planned, hidden: true });
        mine.set(l.linkTypeId, planned.index);
      }
    }
  }
  if (hops.some((h) => h.hidden) && (plan.asOf !== undefined || plan.history !== undefined)) {
    return refuse('plan.computed_over_links_live', 'a property computed over links is computed from the systems now, not as of a past moment', { element: { kind: 'plan' } });
  }

  // Source steps.
  const nodes: NodeProgram[] = [];
  for (const [i, type] of nodeTypes.entries()) {
    const mode = type.type.contributingObjects.length === 1 ? 'single_source' as const : 'merged' as const;
    const needed = new Set<string>(reads[i]);
    if (type.type.resolutionClass === 'resolvable') for (const k of type.type.matchKeys) needed.add(k.propertyIdentityId);
    // A computed property expands into its function's declared inputs (spec 26.7).
    for (const id of [...needed]) for (const input of type.properties.get(id)?.computed?.inputs ?? []) needed.add(input);
    const sources: SourceStep[] = type.type.contributingObjects.map((source) => {
      const fields = new Set<string>([source.identifierFieldPath]);
      for (const id of needed) {
        const m = mappingIn(type.properties.get(id)!, source);
        if (m !== undefined) fields.add(m.fieldPath);
      }
      for (const h of hops) {
        if (h.from === i && h.fromSource === source) fields.add(h.fromField);
        if (h.to === i && h.toSource === source) fields.add(h.toField);
      }
      return { node: i, source, fields: [...fields].sort(), native: [], local: [] };
    });
    let filters = nodeFilters[i]!;
    if (mode === 'single_source') {
      const step = sources[0]!;
      const candidates: { filter: NodeFilter; step: StepFilter }[] = [];
      const local: NodeFilter[] = [];
      for (const f of filters) {
        // A computed property has no field: it is filtered after merge, on its computed value.
        if (f.property.computed !== undefined) { local.push(f); continue; }
        const m = mappingIn(f.property, step.source);
        if (m === undefined) {
          return refuse('plan.filter_unmapped', `${f.property.property.apiName} is not held by the system ${type.type.apiName} comes from`, { element: propertyElement(f.property) });
        }
        if (m.valueMap !== null || m.sourceTimeZone !== null) local.push(f);
        else candidates.push({ filter: f, step: { field: m.fieldPath, op: f.op, ...(f.value === undefined ? {} : { value: f.value }) } as StepFilter });
      }
      if (candidates.length > 0) {
        const explained = await deps.services.call(explainPushdown, {
          body: { connectionId: step.source.connectionId, step: { object: step.source.sourceObject, fields: step.fields, filters: candidates.map((c) => c.step) } },
        }, callOptions(call));
        const pushed = new Set(explained.split.native.filters.map((f) => canonicalJson(f)));
        for (const c of candidates) {
          if (pushed.has(canonicalJson(c.step))) step.native.push(c.step);
          else local.push(c.filter);
        }
      }
      for (const f of local) {
        if (!exactLocally(f.op, f.property.property.dataType)) {
          return refuse('plan.filter_not_supported', `the system ${type.type.apiName} comes from cannot apply ${f.op} on ${f.property.property.apiName}, and it is not exact applied afterwards`, {
            element: propertyElement(f.property),
            remedy: 'ask with an equality or a range, or without that filter',
          });
        }
        const m = mappingIn(f.property, step.source);
        if (m !== undefined) step.local.push({ field: m.fieldPath, op: f.op });
      }
      filters = local;
    } else {
      for (const step of sources) {
        for (const f of filters) {
          const m = mappingIn(f.property, step.source);
          if (m !== undefined) step.local.push({ field: m.fieldPath, op: f.op });
        }
      }
    }
    nodes.push({
      node: i, access: type, mode, sources, filters, period: periods.find((p) => p.node === i),
      restricted: nodeFilters[i]!.length > 0 || plan.nodes[i]?.required === true, reads: needed,
      ...(i >= planNodeCount ? { hidden: true } : {}), ...(linkedHops.has(i) ? { linkedHops: linkedHops.get(i) } : {}),
    });
  }

  // The filtered side leads a single hop between two single-system types (spec 26.11).
  if (hops.length === 1) {
    const [hop] = hops;
    const from = nodes[hop!.from]!;
    const to = nodes[hop!.to]!;
    // A node only required to be reached, with no filter of its own, does not lead: it would be read whole.
    if (hop!.junction === undefined && nodeFilters[hop!.to]!.length > 0 && nodeFilters[hop!.from]!.length === 0 && from.mode === 'single_source' && to.mode === 'single_source') hop!.leads = 'to';
  }

  // 69.16: a history question is the Warehouse's: the objects as they stood at the period's
  // end (or the Warehouse's last sync, for a period still running), each with its changes in
  // the period; or refused.
  let history: Program['history'];
  // 69.6: an as-of question is the Warehouse's, from its history, or refused.
  let asOf: Program['asOf'];
  if (plan.history !== undefined) {
    if (options.index === false) return refuse('plan.history_unavailable', 'a history question is answered on main only', { element: { kind: 'plan' } });
    const range = resolvePeriod(plan.history.expression, 'timestamp', calendar, now, parameters);
    if (isRefusal(range)) return range;
    if (Date.parse(range.from) >= now) {
      return refuse('plan.history_future', 'a history question asks about a period that has begun', { element: { kind: 'plan' } });
    }
    // The Warehouse knows up to its last sync: a period still running ends there, and says so.
    let watermark: string | undefined;
    try {
      watermark = (await deps.services.call(warehouseCoverage, { body: { objectTypeIds: [nodes[0]!.access.type.id] } }, callOptions(call)))
        .types.find((t) => t.objectTypeId === nodes[0]!.access.type.id)?.watermark;
    } catch {
      watermark = undefined;
    }
    const known = Math.min(now, watermark === undefined ? now : Date.parse(watermark));
    // The objects as they stood at the end; the changes up to it, those recorded at the last sync included.
    const at = new Date(Math.min(Date.parse(range.to), known)).toISOString();
    const to = Date.parse(range.to) <= known ? new Date(Date.parse(range.to)).toISOString() : new Date(known + 1).toISOString();
    const answer = await warehouseAnswer(deps, call, plan, nodes[0]!, nodeFilters[0]!, at);
    if (isRefusal(answer)) return answer;
    nodes[0]!.warehouse = answer;
    history = { from: new Date(Date.parse(range.from)).toISOString(), to, asWritten: plan.history.asWritten, properties: plan.select.filter((s) => s.node === 0).map((s) => s.property) };
  } else if (plan.asOf !== undefined) {
    const raw = parameters[plan.asOf.at.param];
    if (raw === undefined) return refuse('plan.parameter_missing', `the plan's value ${plan.asOf.at.param} was not supplied`, { element: { kind: 'parameter', name: plan.asOf.at.param } });
    // A date ("as of 1 March") is the end of that day in the organisation's calendar.
    const isDate = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00Z`));
    if (typeof raw !== 'string' || (!isDate && (!INSTANT.test(raw) || !Number.isFinite(Date.parse(raw))))) {
      return refuse('plan.as_of_value_invalid', 'an as-of instant is a date, or a date and time with its offset', { element: { kind: 'parameter', name: plan.asOf.at.param } });
    }
    const at = isDate ? endOfDate(raw, calendar.timeZone) : new Date(Date.parse(raw)).toISOString();
    if (Date.parse(at) > now) return refuse('plan.as_of_future', 'an as-of instant is in the past; the present is answered without one', { element: { kind: 'parameter', name: plan.asOf.at.param } });
    // A branch or a write's prior state reads live only: no Warehouse holds a branch's past.
    if (options.index === false) return refuse('plan.as_of_unavailable', 'an as-of question is answered on main only', { element: { kind: 'plan' } });
    const answer = await warehouseAnswer(deps, call, plan, nodes[0]!, nodeFilters[0]!, at);
    if (isRefusal(answer)) return answer;
    nodes[0]!.warehouse = answer;
    asOf = { at, asWritten: plan.asOf.asWritten };
  } else if (hops.length === 0 && (plan.aggregate === undefined || (options.facet === true && facetShaped(plan))) && nodes.length === 1
    && nodes[0]!.period === undefined && options.index !== false) {
    // (A computed property over links adds a hidden hop, so the Index never answers one.)
    // 69.6: a single-node lookup or filter on current state, with no period, may be answered by a fresh Object Index.
    const held = await indexHeldFor(deps, call, nodes[0]!, nodeFilters[0]!);
    if (held !== undefined) {
      nodes[0]!.index = indexAnswer(plan, nodes[0]!, nodeFilters[0]!, held, options.freshnessToleranceSeconds);
      // What the index does not hold in full, it may still narrow (a split plan); a facet it cannot serve reads as any aggregate does.
      if (nodes[0]!.index === undefined && plan.aggregate === undefined) {
        nodes[0]!.split = await splitAnswer(deps, call, nodes[0]!, nodeFilters[0]!, held, options.freshnessToleranceSeconds);
      }
    }
  }

  // A facet the index serves is counted over its entries in the engine.
  // A time bucket is the engine's to compute, in the organisation's calendar: never pushed down, never the Warehouse's.
  const bucketed = plan.aggregate?.groupBy.some((g) => g.bucket !== undefined) === true;
  const aggregatePushdown = nodes[0]!.index !== undefined || bucketed ? undefined : await aggregatePushdownOf(deps, call, plan, nodes, hops);
  // 69.6: a large single-type aggregate no source computes per group may be the Warehouse's.
  const across = plan.aggregate !== undefined && hops.length === 1 && !hops[0]!.hidden ? acrossOf(plan, nodes, hops, nodeFilters) : undefined;
  const warehouseAggregate = aggregatePushdown === undefined && !bucketed && plan.aggregate !== undefined && asOf === undefined && history === undefined && nodes[0]!.index === undefined
    && ((hops.length === 0 && nodes.length === 1) || across !== undefined) && options.index !== false
    ? await warehouseAggregateOf(deps, call, plan, nodes[0]!, nodeFilters[0]!, options.freshnessToleranceSeconds, across) : undefined;
  return {
    plan, parameters, manifest, access, nodes, hops, periods, asOf, history, calendar, defaults, aggregatePushdown, warehouseAggregate,
    bounds: {
      rowsPerSource: deps.bounds.maxRowsPerSourceStep,
      keysPerHop: Math.min(deps.bounds.fanOutPerHop, 10_000),
      mergedResult: deps.bounds.maxResultRows,
      wallTimeMs: deps.bounds.wallTimeMs,
    },
  };
}

/** Whether the plan's aggregate is the source's to compute per group, and how (see AggregatePushdown). */
async function aggregatePushdownOf(deps: PlannerDeps, call: PlanCall, plan: QueryPlan, nodes: NodeProgram[], hops: HopProgram[])
  : Promise<AggregatePushdown | undefined> {
  const aggregate = plan.aggregate;
  if (aggregate === undefined || hops.length > 0 || nodes.length !== 1) return undefined;
  const node = nodes[0]!;
  const type = node.access.type;
  if (node.mode === 'single_source') {
    if (node.filters.length > 0 || node.sources[0]!.local.length > 0) return undefined;
  } else if (type.resolutionClass !== 'resolvable' || type.disjointSources !== true) {
    return undefined;
  }
  // Every key and measure read plainly, as stored, from one field in every system.
  const fieldIn = (step: SourceStep, propertyId: string): { field: string; access: PropertyAccess } | undefined => {
    const access = node.access.properties.get(propertyId);
    if (access === undefined || access.effect !== 'allow' || access.computed !== undefined) return undefined;
    const m = access.property.mappings.find((x) => x.connectionId === step.source.connectionId && x.sourceObject === step.source.sourceObject);
    return m === undefined || m.valueMap !== null || m.sourceTimeZone !== null ? undefined : { field: m.fieldPath, access };
  };
  const measures: AggregatePushdown['measures'] = [];
  for (const [i, m] of aggregate.measures.entries()) {
    if (m.node !== 0 || !SPLITTABLE.has(m.fn)) return undefined;
    const fn = m.fn as AggregatePushdown['measures'][number]['fn'];
    if (m.property === undefined) {
      if (fn !== 'count') return undefined;
      measures.push({ as: m.as, fn, column: GROUP_ROWS, countColumn: null, property: null });
      continue;
    }
    const access = node.access.properties.get(m.property);
    if (access === undefined || (fn !== 'count' && !NUMERIC.includes(access.property.dataType))) return undefined;
    const column = `m${i}__${fn === 'avg' ? 'sum' : fn}`;
    measures.push({ as: m.as, fn, column, countColumn: fn === 'count' ? column : `m${i}__n`, property: access });
  }
  const parts: AggregatePart[] = [];
  for (const step of node.sources) {
    const groupBy: AggregatePart['groupBy'] = [];
    for (const g of aggregate.groupBy) {
      const f = fieldIn(step, g.property);
      if (f === undefined) return undefined;
      groupBy.push({ field: f.field, property: f.access });
    }
    const sourceMeasures: StepAggregate['measures'] = [{ fn: 'count', as: GROUP_ROWS }];
    for (const [i, m] of aggregate.measures.entries()) {
      if (m.property === undefined) continue;
      const f = fieldIn(step, m.property);
      if (f === undefined) return undefined;
      const fn = m.fn as AggregatePushdown['measures'][number]['fn'];
      sourceMeasures.push({ fn: fn === 'avg' ? 'sum' : fn, field: f.field, as: `m${i}__${fn === 'avg' ? 'sum' : fn}` });
      if (fn !== 'count') sourceMeasures.push({ fn: 'count', field: f.field, as: `m${i}__n` });
    }
    // A disjoint type's filters run in each system, on its one record of each object (each value is that system's only).
    const filters: StepFilter[] = [];
    if (node.mode === 'merged') {
      for (const f of node.filters) {
        const mapped = fieldIn(step, f.property.property.identityId);
        if (mapped === undefined) return undefined;
        filters.push({ field: mapped.field, op: f.op, ...(f.value === undefined ? {} : { value: f.value }) } as StepFilter);
      }
    }
    const stepAggregate: StepAggregate = { groupBy: groupBy.map((g) => g.field), measures: sourceMeasures };
    const pushedFilters = [...step.native, ...filters];
    const explained = await deps.services.call(explainPushdown, {
      body: { connectionId: step.source.connectionId, step: { object: step.source.sourceObject, fields: step.fields, filters: pushedFilters, aggregate: stepAggregate } },
    }, callOptions(call));
    const split = explained.split;
    if (split.native.aggregate === null || split.residual.aggregate !== null || split.residual.filters.length > 0) return undefined;
    parts.push({ step, aggregate: stepAggregate, filters: pushedFilters, groupBy });
  }
  // The declaration is relied on only where the entity graph does not contradict it (27.7).
  if (node.mode === 'merged') {
    const partition = await deps.services.call(checkSourcePartition, { params: { objectTypeId: type.id } }, callOptions(call));
    if (partition.overlapping) return undefined;
  }
  return { parts, measures };
}

/**
 * A hop through a junction object (spec 21.8: "a junction object with two foreign keys is
 * many-to-many"). The route names the junction's key to one side (its foreign key field and
 * the referenced field of the route's source object); the junction's key to the other side is
 * the relationship its manifest declares to that side's object. Without one it cannot be
 * followed, and the plan says so.
 */
async function junctionHop(deps: PlannerDeps, call: PlanCall, h: {
  index: number; from: number; to: number; link: LinkTypeView; route: LinkRouteView; fromType: ObjectTypeView; toType: ObjectTypeView;
}): Promise<HopProgram | Refusal> {
  const { route, link } = h;
  const objectOf = (t: ObjectTypeView, name: string) => t.contributingObjects.find((c) => c.connectionId === route.connectionId && c.sourceObject === name);
  const aType = objectOf(h.fromType, route.sourceObject) !== undefined ? h.fromType : objectOf(h.toType, route.sourceObject) !== undefined ? h.toType : undefined;
  const element = { kind: 'link_type' as const, id: link.id, name: link.apiName };
  if (aType === undefined) return refuse('plan.junction_route', `${link.apiName}'s route reads ${route.sourceObject}, which neither linked type comes from`, { element });
  const bType = aType === h.fromType ? h.toType : h.fromType;
  const manifest = await inTransaction(deps.databases.pool('control'), call.request, async (db) => {
    const connection = await connectionRepo.findById(db, route.connectionId);
    const row = connection === undefined ? undefined : await connectorManifestRepo.findById(db, connection.manifestId);
    return manifestSchema.safeParse(row?.document);
  }, { readOnly: true });
  const junction = manifest.success ? manifest.data.objects.find((o) => o.name === route.junctionObject) : undefined;
  const other = junction?.relationships.find((r) => r.kind !== 'reference' && r.field !== route.foreignKeyField && objectOf(bType, r.targetObject) !== undefined);
  if (junction === undefined || other === undefined) {
    return refuse('plan.junction_undeclared', `the junction ${route.junctionObject} declares no key to ${bType.apiName}, so ${link.apiName} cannot be followed through it`, {
      element, remedy: 'declare the junction\'s foreign key to the other object in the connector',
    });
  }
  const a = { source: objectOf(aType, route.sourceObject)!, field: route.referencedField, junctionField: route.foreignKeyField };
  const b = { source: objectOf(bType, other.targetObject)!, field: other.targetField, junctionField: other.field };
  const [f, t] = aType === h.fromType ? [a, b] : [b, a];
  return {
    index: h.index, from: h.from, to: h.to, link, route, fromSource: f.source, fromField: f.field, toSource: t.source, toField: t.field, leads: 'from',
    junction: { object: route.junctionObject!, fromField: f.junctionField, toField: t.junctionField },
  };
}

export function explanationOf(program: Program): PlanExplanation {
  return {
    nodes: program.nodes.map((n) => ({
      node: n.node, objectTypeId: n.access.type.id, mode: n.mode,
      sources: n.sources.map((s) => ({
        connectionId: s.source.connectionId, sourceObject: s.source.sourceObject, fields: s.fields, nativeFilters: s.native.length, localFilters: s.local,
      })),
    })),
    hops: program.hops.map((h) => ({ hop: h.index, linkTypeId: h.link.id, routeId: h.route.id, leads: h.leads })),
    bounds: program.bounds,
    periods: program.periods.map((p) => ({ node: p.node, property: p.property, asWritten: p.asWritten, from: p.from, to: p.to })),
    ...(program.manifest.version.branchKind === 'main' ? {} : { branch: { branchId: program.manifest.version.branchId, kind: program.manifest.version.branchKind } }),
    ...(program.warehouseAggregate === undefined ? {} : {
      aggregate: { source: 'warehouse' as const, watermark: program.warehouseAggregate.watermark, reason: program.warehouseAggregate.reason },
    }),
    ...(program.asOf === undefined ? {} : {
      asOf: { asWritten: program.asOf.asWritten, at: program.asOf.at, source: 'warehouse' as const, watermark: program.nodes[0]!.warehouse!.watermark },
    }),
    ...(program.history === undefined ? {} : {
      history: {
        asWritten: program.history.asWritten, from: program.history.from, to: program.history.to, source: 'warehouse' as const,
        watermark: program.nodes[0]!.warehouse!.watermark,
      },
    }),
  };
}

export { FILTER_OPS };
