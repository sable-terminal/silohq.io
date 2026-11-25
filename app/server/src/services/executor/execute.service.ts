// The executor (spec 27): decompose → pushdown → stream-bound → merge → aggregate → bound,
// deterministic, with no model in the path.
//
// 1. The planner decomposes the plan against the reader's access now.
// 2. A cached complete result for the same plan, period resolution, ontology version and
//    permissions answers at once (never metered).
// 3. Each node's systems are read through connect-runtime under the per-source bound; a
//    source cut short, halted or unreachable refuses the plan, naming it, rather than
//    answering from the rest (27.4, 27.12).
// 4. Rows merge into objects (a resolvable type through resolution's entity graph, a
//    single-source type by its identifier); filters the systems could not apply run on
//    decided values. A value disputed or unchecked is never filtered, sorted or measured on.
// 5. Hops pair objects by the route's key: a bounded key set read by identity (27.5), the
//    filtered side first. A filtered linked node narrows its parent to those it reaches.
// 6. Order after merge and before the limit, disputed and empty values last (27.6);
//    aggregates over merged objects, each linked object counted once per group (27.7).
// 7. A result larger than one answer may cover is refused, never truncated (27.8).
// 8. Field policies shape what leaves: masked values show at most their last four
//    characters, redacted ones nothing.

import { readObjectIndex } from '../../contracts/index-builder/index.contract.ts';
import { aggregateWarehouse, readWarehouseAsOf, readWarehouseHistory } from '../../contracts/warehouse/read.contract.ts';
import { enqueueObservations, observationsOf, type IntakeDeps } from '../siloes-capture/intake.service.ts';
import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import { reportSourceDrift } from '../../contracts/connector-maintenance/maintenance.contract.ts';
import type { StepFilter } from '../../contracts/connect/step.contract.ts';
import type {
  ColumnLineage, QueryResult, ResultGroup, ResultObject, RunOutcome,
} from '../../contracts/executor/result.contract.ts';
import type { PlanParameters, QueryPlan, Refusal } from '../../contracts/planner/plan.contract.ts';
import { MAX_RESOLVE_ROWS, resolveRecords } from '../../contracts/resolution/resolve.contract.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { isRefusal, type ContributingObjectView, type PropertyAccess } from '../planner/access.service.ts';
import { buildProgram, GROUP_ROWS, type NodeProgram, type Program, type SourceStep } from '../planner/decompose.service.ts';
import { callOptions, type PlanCall, type PlannerDeps } from '../planner/deps.service.ts';
import { isInterfacePlan } from '../planner/interfacePlans.service.ts';
import { runInterfacePlan } from './interfacePlan.service.ts';
import { recordQueryEvent } from './events.service.ts';
import { mergeResolvable, mergeSingleSource, ResolveBound, undecided, type MergedObject, type Row } from './merge.service.ts';
import { pageOf, type CacheParts, type Results } from './results.service.ts';
import { bucketStart } from '../planner/period.service.ts';
import { compareTyped, masked, satisfies, typed, type Json } from './values.service.ts';
import { compileCel, type CompiledCel } from '../expression-evaluator/cel.service.ts';

export interface ExecutorDeps extends PlannerDeps {
  results: Results;
  /** Capture's queue (spec 67.2): what an answer observed is queued for Capture Siloes holding its types. */
  capture?: IntakeDeps | undefined;
}

/**
 * Capture rides on the answer (spec 67.2): the root objects' values, each with the connection
 * it came from, queued for the Capture Siloes holding the type. Never awaited by the question
 * and never failing it: a failure is a logged capture gap.
 */
function captureAnswer(deps: ExecutorDeps, request: PlanCall['request'], built: { header: Omit<QueryResult, 'page' | 'cached'>; items: (ResultObject | ResultGroup)[] }): void {
  if (deps.capture === undefined || built.header.kind !== 'objects') return;
  const lineage = built.header.lineage.filter((l) => l.node === 0);
  const objects = built.items.filter((i): i is ResultObject => 'id' in i);
  const observations = observationsOf(objects, (apiName) => lineage.find((l) => l.propertyApiName === apiName)?.sources[0]?.connectionId);
  void enqueueObservations(deps.capture, request, 'query', observations, built.header.computedAt).catch((error: unknown) => {
    deps.logger.failure('an answer could not be queued for capture: a capture gap', error, { event: 'siloes.capture_gap', organisationId: request.organisationId! });
  });
}

export interface RunInput {
  plan: QueryPlan;
  parameters: PlanParameters;
  planId?: string | undefined;
  trigger: string;
  useCache: boolean;
  /**
   * A saved set's membership test on the root's merged objects (spec 24.4), applied after the
   * merge and before ordering: its hash keys the cache, its properties must be shown plainly.
   */
  keep?: { hash: string; properties: readonly string[]; test: (subject: Record<string, Json | null>, objectId: string) => boolean } | undefined;
  /** Each object's source records, by identifier (a Cron's mutation, 40.5). */
  references?: boolean | undefined;
}

/** Why the Warehouse could not answer an as-of question at run time (69.6), in the asker's terms. */
const AS_OF_DECLINED = {
  not_held: 'the Warehouse no longer holds what this question asks about',
  withheld: 'what the Warehouse holds of this is not visible to you in full',
  no_access: 'your access does not reach the systems this came from',
  before_history: 'the Warehouse\'s history does not reach back to the instant asked about',
} as const;

const HISTORY_DECLINED = {
  ...AS_OF_DECLINED,
  before_history: 'the Warehouse\'s history does not reach back to the start of the period asked about',
} as const;

/** Thrown inside a run to end it with a refusal. */
export class Refused extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.code);
    this.refusal = refusal;
  }
}

const IN_CHUNK = 1_000;

/** What a source read failure means for the plan (spec 27.12). */
function refusalOfRead(error: unknown, step: SourceStep): Refusal | undefined {
  if (!isAppError(error)) return undefined;
  const connectionId = step.source.connectionId;
  const element = { kind: 'connection' as const, id: connectionId };
  if (error.code === 'connect.rows_per_source_step') {
    const limit = Number(error.details['limit'] ?? 0);
    return {
      code: 'query.bound_rows_per_source', reason: `a system returned more than ${limit} rows for one step; refused rather than answered in part`,
      element, bound: { name: 'rows_per_source_step', limit, connectionId }, remedy: 'narrow the question with a filter or a period',
    };
  }
  if (error.code === 'connect.wall_time' || error.category === 'timeout') {
    return { code: 'query.bound_wall_time', reason: 'the question ran past its time bound; refused rather than answered in part', element, bound: { name: 'wall_time', limit: 0, connectionId } };
  }
  if (error.code === 'source.bounds') {
    return { code: 'query.bound_source', reason: 'a system refused the request as too large', element, bound: { name: 'source_bound', limit: 0, connectionId } };
  }
  if (error.code?.startsWith('connection.') || error.code?.startsWith('source.') || ['unavailable', 'upstream', 'rate_limited', 'unauthenticated'].includes(error.category)) {
    return {
      code: 'query.source_unavailable', reason: 'a system this question needs is not answering, so no answer is given from the others as if complete',
      element, remedy: error.code === 'source.auth' ? 'reconnect the connection' : 'try again when the connection is healthy',
    };
  }
  return undefined;
}

/** What a failed read says about the manifest (spec 17.3): drift worth a re-check, or nothing (an outage, a limit). */
function driftOf(error: unknown): 'auth' | 'object_missing' | 'source_error' | undefined {
  if (!isAppError(error)) return undefined;
  return error.code === 'source.auth' ? 'auth' : error.code === 'source.not_found' ? 'object_missing'
    : error.code === 'source.validation' ? 'source_error' : undefined;
}

/**
 * A source that contradicted its manifest is reported to connector-maintenance for a re-check
 * (spec 17.3: a runtime self-heal). Never awaited and never failing the question: the
 * re-check is rate limited there, and a lost report is only logged.
 */
function reportDrift(deps: ExecutorDeps, call: PlanCall, connectionId: string, signal: 'auth' | 'object_missing' | 'source_error' | 'type_mismatch'): void {
  void deps.services.call(reportSourceDrift, { params: { connectionId }, body: { signal } }, callOptions(call)).catch((error: unknown) => {
    deps.logger.debug('a source drift report was not delivered', { event: 'executor.drift_unreported', connectionId, reason: isAppError(error) ? error.code : 'error' });
  });
}

/** The value of a property on an object, as shown. */
interface Shown { value: Json | null; disputed: boolean; masked: boolean; redacted: boolean }

export function show(object: MergedObject, p: PropertyAccess): Shown {
  const decided = object.values.get(p.property.identityId) ?? { value: null, state: 'empty' as const };
  if (decided.state === 'disputed') return { value: null, disputed: true, masked: false, redacted: false };
  if (decided.state === 'unchecked') return { value: null, disputed: false, masked: false, redacted: false };
  if (p.effect === 'redact') return { value: null, disputed: false, masked: false, redacted: decided.value !== null };
  if (p.effect === 'mask') return { value: masked(decided.value), disputed: false, masked: decided.value !== null, redacted: false };
  return { value: decided.value, disputed: false, masked: false, redacted: false };
}

/** Disputed and empty values sort last in either direction (spec 27.6). */
function orderBy<T>(items: T[], keys: { get: (item: T) => { value: Json | null; undecided: boolean }; type: Parameters<typeof compareTyped>[2]; desc: boolean }[],
  tie: (item: T) => string): T[] {
  return items.map((item) => ({ item, at: keys.map((k) => k.get(item)) })).sort((a, b) => {
    for (const [i, k] of keys.entries()) {
      const x = a.at[i]!;
      const y = b.at[i]!;
      const xLast = x.undecided || x.value === null;
      const yLast = y.undecided || y.value === null;
      if (xLast !== yLast) return xLast ? 1 : -1;
      if (xLast) continue;
      const c = compareTyped(x.value!, y.value!, k.type);
      if (c !== 0) return k.desc ? -c : c;
    }
    const tx = tie(a.item);
    const ty = tie(b.item);
    return tx < ty ? -1 : tx > ty ? 1 : 0;
  }).map((e) => e.item);
}

/** Steps one computed value may take, at most (each function also states its own, lower or not). */
const COMPUTE_TIME_MS = 10;
const computeCache = new Map<string, CompiledCel>();
const COMPUTED_MAPPING = { valueMap: null, sourceTimeZone: null } as unknown as Parameters<typeof typed>[2];

/**
 * Computed properties (spec 21.11), evaluated after merge for every object of the node: the
 * function's CEL over `object` (its inputs by API name) and `now`, the run's evaluation time.
 * If any input is disputed, unchecked or empty, there is no value and the object counts as
 * undecided for it; an expression that fails or runs past its budget is undecided too.
 */
export function computeProperties(node: NodeProgram, objects: readonly MergedObject[], now: Date): void {
  // Over links: computed once the linked objects are read (computeLinked).
  const computed = [...node.access.properties.values()].filter((p) => p.computed !== undefined && p.computed.links === undefined && node.reads.has(p.property.identityId));
  for (const p of computed) {
    const spec = p.computed!;
    let program = computeCache.get(spec.functionVersionId);
    if (program === undefined) {
      program = compileCel(spec.expression, { object: 'map', links: 'map', params: 'map', now: 'timestamp' });
      computeCache.set(spec.functionVersionId, program);
    }
    const inputs = spec.inputs.map((id) => node.access.properties.get(id)!);
    for (const o of objects) {
      const object: Record<string, Json> = {};
      let missing = false;
      for (const input of inputs) {
        const d = o.values.get(input.property.identityId);
        if (d === undefined || undecided(d.state) || d.value === null) { missing = true; break; }
        object[input.property.apiName] = d.value;
      }
      if (missing) { o.values.set(p.property.identityId, { value: null, state: 'unchecked' }); continue; }
      try {
        const out = program.evaluate({ object, links: {}, params: {}, now }, { steps: spec.costLimit, timeMs: COMPUTE_TIME_MS });
        // A computed value is typed by the property as a source value would be, with no value map or time zone to apply.
        const raw = out instanceof Date ? out.toISOString() : out;
        const value = raw === null || raw === undefined ? null : typed(raw, p.property.dataType, COMPUTED_MAPPING);
        o.values.set(p.property.identityId, value === null ? { value: null, state: 'empty' } : { value, state: 'only' });
      } catch {
        o.values.set(p.property.identityId, { value: null, state: 'unchecked' });
      }
    }
  }
}

export class Run {
  readonly deps: ExecutorDeps;
  readonly call: PlanCall;
  readonly program: Program;
  readonly signal: AbortSignal;
  readonly readAt = new Map<SourceStep, string>();
  readonly pushedFilter = new Set<SourceStep>();
  /** Steps read from an Import Silo's store (66.5), with the Silo: their values may be extracted from documents (68.4). */
  readonly siloOf = new Map<SourceStep, string>();
  /** Alive objects per node. */
  readonly population: MergedObject[][] = [];
  /** links.get(objectId).get(hopIndex): the linked objects. */
  readonly links = new Map<string, Map<number, MergedObject[]>>();
  excludedByDispute = 0;
  bytes = 0;
  /** The evaluation time computed properties read (spec 21.11): one for the whole run. */
  readonly now = new Date();
  /**
   * Partial aggregate pushdown (27.7), or the Warehouse's aggregate (69.6): the groups as
   * computed there, the population, non-null counts by property, and (the Warehouse) disputed ones.
   */
  pushed: { groups: ResultGroup[]; rows: number; counts: Map<string, number>; disputed?: Map<string, number> } | undefined;
  readonly mayPushAggregate: boolean;
  readonly references: boolean;

  constructor(deps: ExecutorDeps, call: PlanCall, program: Program, signal: AbortSignal, options: { mayPushAggregate?: boolean; references?: boolean } = {}) {
    this.deps = deps;
    this.call = call;
    this.program = program;
    this.signal = signal;
    this.mayPushAggregate = options.mayPushAggregate ?? true;
    this.references = options.references ?? false;
  }

  /**
   * The Warehouse computes a large aggregate (69.6), as of its watermark, which the answer
   * states. False, having used nothing, where it declines now or cannot be reached: the
   * sources are read instead.
   */
  async readWarehouseAggregate(): Promise<boolean> {
    const answer = this.program.warehouseAggregate!;
    let out: Awaited<ReturnType<typeof this.deps.services.call<typeof aggregateWarehouse>>>;
    try {
      out = await this.deps.services.call(aggregateWarehouse, {
        body: {
          objectTypeId: this.program.nodes[0]!.access.type.id, groupBy: answer.groupBy, measures: answer.measures, filters: answer.filters as never,
          limit: this.deps.bounds.maxResultRows, ...(answer.hop === undefined ? {} : { hop: answer.hop }),
        },
      }, { ...callOptions(this.call), signal: this.signal, timeoutMs: this.program.bounds.wallTimeMs });
    } catch {
      return false;
    }
    if (out.outcome !== 'read') return false;
    this.population[0] = [];
    this.excludedByDispute += out.excludedByDispute;
    this.pushed = {
      groups: out.groups.map((g) => ({ ...g, key: g.key as Record<string, Json> })), rows: out.population,
      counts: new Map(Object.entries(out.values)), disputed: new Map(Object.entries(out.disputed)),
    };
    this.servedBy.set(0, { kind: 'warehouse', asOf: answer.watermark, reason: answer.reason });
    // Across a link (D116): the linked type's measures came from the Warehouse too, as of the same moment.
    if (answer.hop !== undefined) {
      this.servedBy.set(1, { kind: 'warehouse', asOf: answer.watermark, reason: answer.reason });
      this.population[1] = [];
    }
    return true;
  }

  /**
   * The source computes the aggregate per group; the engine combines its columns (spec 27.7):
   * a count or a sum as given, an average as the sum over the count of values, a minimum or
   * maximum as given. Values left out of a measure (null) are counted, as over merged objects.
   * False, having read nothing, when the source would not compute it natively after all.
   */
  async readAggregate(): Promise<boolean> {
    const pushdown = this.program.aggregatePushdown!;
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const keyNames = this.program.plan.aggregate!.groupBy.map((g) => this.program.nodes[0]!.access.properties.get(g.property)!.property.apiName);
    // Each system's groups, added by key: counts and sums add, minimum and maximum of the parts', averages from summed sums and counts.
    const buckets = new Map<string, { key: Record<string, Json>; objects: number; values: Map<string, { value: number | null; n: number }> }>();
    const counts = new Map<string, number>();
    const add = (id: string, n: number) => counts.set(id, (counts.get(id) ?? 0) + n);
    let rows = 0;
    for (const part of pushdown.parts) {
      const step = part.step;
      let out;
      try {
        out = await this.deps.services.call(readObject, {
          body: { connectionId: step.source.connectionId, reason: 'query', step: { object: step.source.sourceObject, filters: part.filters, aggregate: part.aggregate } },
        }, { ...callOptions(this.call), signal: this.signal, timeoutMs: this.program.bounds.wallTimeMs });
      } catch (error) {
        const refusal = refusalOfRead(error, step);
        if (refusal !== undefined) throw new Refused(refusal);
        throw error;
      }
      // A system that would not compute it after all: the sources are read instead.
      if (out.pushdown.native.aggregate === null) return false;
      if (out.pushdown.native.filters.length > 0) this.pushedFilter.add(step);
      this.readAt.set(step, new Date().toISOString());
      for (const row of out.rows) {
        const objects = num(row[GROUP_ROWS]) ?? 0;
        if (objects === 0) continue;
        rows += objects;
        const key: Record<string, Json> = {};
        for (const g of part.groupBy) {
          const value = (row[g.field] ?? null) as Json;
          key[g.property.property.apiName] = value;
          if (value !== null) add(g.property.property.identityId, objects);
        }
        const id = JSON.stringify(keyNames.map((n) => key[n] ?? null));
        const bucket = buckets.get(id) ?? { key, objects: 0, values: new Map() };
        bucket.objects += objects;
        for (const m of pushdown.measures) {
          if (m.property === null) continue;
          const n = num(row[m.countColumn!]) ?? 0;
          const value = num(row[m.column]);
          const was = bucket.values.get(m.as) ?? { value: null, n: 0 };
          const combined = value === null ? was.value : was.value === null ? value
            : m.fn === 'min' ? Math.min(was.value, value) : m.fn === 'max' ? Math.max(was.value, value) : was.value + value;
          bucket.values.set(m.as, { value: m.fn === 'count' ? (was.value ?? 0) + n : combined, n: was.n + n });
        }
        buckets.set(id, bucket);
      }
    }
    const groups: ResultGroup[] = [...buckets.values()].map((b) => {
      const measures: Record<string, number | null> = {};
      const excluded: Record<string, number> = {};
      for (const m of pushdown.measures) {
        if (m.property === null) {
          measures[m.as] = b.objects;
          excluded[m.as] = 0;
          continue;
        }
        const v = b.values.get(m.as) ?? { value: null, n: 0 };
        excluded[m.as] = b.objects - v.n;
        measures[m.as] = m.fn === 'count' ? v.n : v.n === 0 ? null : m.fn === 'avg' ? (v.value ?? 0) / v.n : v.value;
      }
      return { key: b.key, measures, objects: b.objects, excluded };
    });
    // Non-null values per measured property, across groups.
    for (const m of pushdown.measures) {
      if (m.property === null) continue;
      counts.set(m.property.property.identityId, groups.reduce((t, g) => t + g.objects - (g.excluded[m.as] ?? 0), 0));
    }
    this.population[0] = [];
    this.pushed = { groups, rows, counts };
    return true;
  }

  async readStep(step: SourceStep, extra: StepFilter | undefined): Promise<Row[]> {
    const filters = extra === undefined ? step.native : [...step.native, extra];
    try {
      const out = await this.deps.services.call(readObject, {
        body: { connectionId: step.source.connectionId, reason: 'query', step: { object: step.source.sourceObject, fields: step.fields, filters } },
      }, { ...callOptions(this.call), signal: this.signal, timeoutMs: this.program.bounds.wallTimeMs });
      if (out.pushdown.native.filters.length > 0) this.pushedFilter.add(step);
      if (out.siloId !== null) this.siloOf.set(step, out.siloId);
      if (out.stats.typeMismatches > 0) reportDrift(this.deps, this.call, step.source.connectionId, 'type_mismatch');
      this.readAt.set(step, new Date().toISOString());
      this.bytes += Buffer.byteLength(JSON.stringify(out.rows));
      if (this.bytes > this.deps.bounds.localStepBytes) {
        throw new Refused({
          code: 'query.bound_local_bytes', reason: 'the rows this question needs exceed the engine\'s working bound; refused rather than answered in part',
          bound: { name: 'local_step_bytes', limit: this.deps.bounds.localStepBytes },
        });
      }
      return out.rows as Row[];
    } catch (error) {
      if (error instanceof Refused) throw error;
      const drift = driftOf(error);
      if (drift !== undefined) reportDrift(this.deps, this.call, step.source.connectionId, drift);
      const refusal = refusalOfRead(error, step);
      if (refusal !== undefined) throw new Refused(refusal);
      throw error;
    }
  }

  /** A history question's changes (69.16), by root object id, oldest first. */
  readonly changes = new Map<string, { property: string; at: string; previous: Json | null; value: Json | null }[]>();

  /**
   * The changes in a history question's period to its properties of the root objects (69.16),
   * from the Warehouse. Refused, never answered in part, where the Warehouse declines.
   */
  async readHistory(roots: MergedObject[]): Promise<void> {
    const history = this.program.history!;
    const node = this.program.nodes[0]!;
    const out = await this.deps.services.call(readWarehouseHistory, {
      body: {
        objectTypeId: node.access.type.id, properties: history.properties, from: history.from, to: history.to,
        objectIds: roots.map((o) => o.id), limit: this.deps.bounds.maxResultRows,
      },
    }, { ...callOptions(this.call), signal: this.signal, timeoutMs: this.program.bounds.wallTimeMs });
    if (out.outcome !== 'read') {
      throw new Refused(out.reason === 'bounded'
        ? { code: 'query.bound_merged_result', reason: `more than ${this.deps.bounds.maxResultRows} changes in the period; refused, never truncated`,
          bound: { name: 'merged_result', limit: this.deps.bounds.maxResultRows }, remedy: 'ask about a shorter period, or fewer objects' }
        : { code: 'query.history_unavailable', reason: HISTORY_DECLINED[out.reason], element: { kind: 'object_type', id: node.access.type.id, name: node.access.type.apiName } });
    }
    for (const c of out.changes) {
      const list = this.changes.get(c.objectId) ?? [];
      list.push({ property: c.property, at: c.at, previous: c.previous as Json | null, value: c.value as Json | null });
      this.changes.set(c.objectId, list);
    }
  }

  /** Nodes the Object Index or the Warehouse answered (69.6), with the instant the answer is as of, which it states. */
  readonly servedBy = new Map<number, { kind: 'index' | 'warehouse'; asOf: string; reason: string }>();

  /**
   * The Warehouse's read of an as-of node (69.6). No system holds the past, so a decline is
   * a refusal, never a live read. Each property as it stood at the instant; a value disputed
   * then is disputed in the answer.
   */
  async readAsOf(node: NodeProgram): Promise<MergedObject[]> {
    const answer = node.warehouse!;
    const out = await this.deps.services.call(readWarehouseAsOf, {
      body: { objectTypeId: node.access.type.id, properties: answer.properties, filters: answer.filters as never, asOf: answer.at, limit: this.deps.bounds.maxResultRows },
    }, { ...callOptions(this.call), signal: this.signal, timeoutMs: this.program.bounds.wallTimeMs });
    if (out.outcome !== 'read') {
      throw new Refused(out.reason === 'bounded'
        ? { code: 'query.bound_merged_result', reason: `more than ${this.deps.bounds.maxResultRows} objects stood then; refused, never truncated`,
          bound: { name: 'merged_result', limit: this.deps.bounds.maxResultRows } }
        : { code: 'query.as_of_unavailable', reason: AS_OF_DECLINED[out.reason], element: { kind: 'object_type', id: node.access.type.id, name: node.access.type.apiName } });
    }
    this.servedBy.set(node.node, { kind: 'warehouse', asOf: out.asOf, reason: answer.reason });
    return out.rows.map((row) => ({
      id: row.objectId, typeId: node.access.type.id, records: [], unmatched: false,
      values: new Map(answer.properties.map((id) => {
        const apiName = node.access.properties.get(id)?.property.apiName ?? '';
        const v = row.values[apiName] ?? null;
        const state = row.disputed.includes(apiName) ? 'disputed' as const : v === null ? 'empty' as const : 'only' as const;
        return [id, { value: state === 'disputed' ? null : v as Json | null, state }];
      })),
    }));
  }

  /**
   * The Object Index's read of a node the planner gave it (69.6): undefined where the index
   * declines now (withheld, not refreshed, unreachable, or past the row bound), and the
   * sources are read instead. Entries are objects already merged and decided.
   */
  async readIndexed(node: NodeProgram): Promise<MergedObject[] | undefined> {
    const answer = node.index!;
    let out: Awaited<ReturnType<typeof this.deps.services.call<typeof readObjectIndex>>>;
    try {
      out = await this.deps.services.call(readObjectIndex, {
        body: { objectTypeId: node.access.type.id, properties: answer.properties, filters: answer.filters as never, limit: this.deps.bounds.maxRowsPerSourceStep },
      }, { ...callOptions(this.call), signal: this.signal, timeoutMs: this.program.bounds.wallTimeMs });
    } catch {
      return undefined;
    }
    if (out.outcome !== 'read' || !out.exact) return undefined;
    this.servedBy.set(node.node, { kind: 'index', asOf: out.refreshedAt, reason: answer.reason });
    // Left out on a disputed filter value, as the engine counts them.
    this.excludedByDispute += out.excludedByDispute;
    return out.rows.map((row) => ({
      id: row.objectId, typeId: node.access.type.id, records: [], unmatched: false,
      values: new Map(answer.properties.map((id) => {
        const apiName = node.access.properties.get(id)?.property.apiName ?? '';
        const v = row.values[apiName] ?? null;
        const state = row.states[apiName] ?? (v === null ? 'empty' as const : 'only' as const);
        return [id, { value: state === 'disputed' ? null : v as Json | null, state }];
      })),
    }));
  }

  /** Nodes whose set a split plan took from the Object Index (69.6), as of its refresh; their values are read live. */
  readonly narrowedBy = new Map<number, { kind: 'index'; asOf: string; reason: string }>();

  /**
   * A split plan (69.6): the Object Index's keys for the objects meeting the filters, then the
   * system read live by key, the filters applied again to the live values. Undefined where the
   * index declines now or holds more keys than one read may take: the system is read whole.
   */
  async readSplit(node: NodeProgram): Promise<MergedObject[] | undefined> {
    const split = node.split!;
    let out: Awaited<ReturnType<typeof this.deps.services.call<typeof readObjectIndex>>>;
    try {
      out = await this.deps.services.call(readObjectIndex, {
        body: { objectTypeId: node.access.type.id, properties: [split.identifier], filters: split.filters as never, limit: this.program.bounds.keysPerHop },
      }, { ...callOptions(this.call), signal: this.signal, timeoutMs: this.program.bounds.wallTimeMs });
    } catch {
      return undefined;
    }
    if (out.outcome !== 'read' || !out.exact) return undefined;
    const apiName = node.access.properties.get(split.identifier)!.property.apiName;
    const keys = [...new Set(out.rows.map((r) => r.values[apiName]).filter((v): v is string | number | boolean => v !== null && v !== undefined && typeof v !== 'object'))];
    this.narrowedBy.set(node.node, { kind: 'index', asOf: out.refreshedAt, reason: split.reason });
    if (keys.length === 0) return [];
    return this.readNode(node, { source: node.sources[0]!.source, field: split.field, keys });
  }

  /** Reads a node's systems (restricted to keys on one of them, for a hop), merges and filters. */
  async readNode(node: NodeProgram, keyed?: { source: ContributingObjectView; field: string; keys: Json[] }): Promise<MergedObject[]> {
    if (node.warehouse !== undefined) {
      const past = await this.readAsOf(node);
      computeProperties(node, past, new Date(node.warehouse.at));
      return past;
    }
    if (node.split !== undefined && keyed === undefined) {
      const narrowed = await this.readSplit(node);
      if (narrowed !== undefined) return narrowed;
    }
    if (node.index !== undefined && keyed === undefined) {
      const served = await this.readIndexed(node);
      if (served !== undefined) {
        computeProperties(node, served, this.now);
        return served;
      }
    }
    const reads = await Promise.all(node.sources.map(async (step) => {
      if (keyed === undefined || keyed.source !== step.source || node.mode === 'merged') {
        return { source: step.source, rows: await this.readStep(step, undefined) };
      }
      const rows: Row[] = [];
      for (let i = 0; i < keyed.keys.length; i += IN_CHUNK) {
        const chunk = keyed.keys.slice(i, i + IN_CHUNK) as (string | number | boolean)[];
        rows.push(...await this.readStep(step, { field: keyed.field, op: 'in', value: chunk } as StepFilter));
      }
      return { source: step.source, rows };
    }));
    const objects = node.access.type.resolutionClass === 'resolvable'
      ? await this.resolve(node, reads)
      : mergeSingleSource(this.call.request.organisationId!, node, reads);
    computeProperties(node, objects, this.now);
    if (node.filters.length === 0) return objects;
    return objects.filter((object) => {
      for (const f of node.filters) {
        // A filter on a property computed over links waits for the linked objects (computeLinked).
        if (f.property.computed?.links !== undefined) continue;
        const decided = object.values.get(f.property.property.identityId) ?? { value: null, state: 'empty' as const };
        if (decided.state === 'disputed') {
          this.excludedByDispute += 1;
          return false;
        }
        if (!satisfies(decided.value, f.op, f.value, f.property.property.dataType)) return false;
      }
      return true;
    });
  }

  /** A resolvable node's rows through the entity graph; refused, never guessed, when it cannot answer. */
  async resolve(node: NodeProgram, reads: { source: ContributingObjectView; rows: Row[] }[]): Promise<MergedObject[]> {
    const type = node.access.type;
    try {
      return await mergeResolvable(
        (body) => this.deps.services.call(resolveRecords, { body }, { ...callOptions(this.call), signal: this.signal, timeoutMs: this.program.bounds.wallTimeMs }),
        this.call.request.organisationId!, this.program.manifest.version.id, node, reads);
    } catch (error) {
      if (error instanceof ResolveBound) {
        throw new Refused({
          code: 'query.bound_resolution_rows', reason: `too many records of ${type.apiName} share one key to be matched in one pass; refused rather than answered in part`,
          element: { kind: 'object_type', id: type.id, name: type.apiName },
          bound: { name: 'resolution_rows', limit: MAX_RESOLVE_ROWS, observed: error.rows }, remedy: 'narrow the question with a filter or a period',
        });
      }
      if (isAppError(error) && ['unavailable', 'upstream', 'timeout', 'rate_limited', 'unauthenticated'].includes(error.category)) {
        throw new Refused({
          code: 'query.resolution_unavailable',
          reason: `records of ${type.apiName} from several systems cannot be matched just now, so no answer is given as if they were`,
          element: { kind: 'object_type', id: type.id, name: type.apiName }, remedy: 'try again shortly',
        });
      }
      throw error;
    }
  }

  /** The raw key values an object holds in one field of one system's records. */
  keysOf(object: MergedObject, source: ContributingObjectView, field: string): Json[] {
    const out: Json[] = [];
    for (const r of object.records) {
      if (r.source.connectionId !== source.connectionId || r.source.sourceObject !== source.sourceObject) continue;
      const v = r.row[field];
      if (v !== null && v !== undefined) out.push(v);
    }
    return out;
  }

  boundKeys(keys: Json[], hop: number): Json[] {
    const distinct = [...new Map(keys.map((k) => [String(k), k])).values()];
    const limit = this.program.bounds.keysPerHop;
    if (distinct.length > limit) {
      throw new Refused({
        code: 'query.bound_keys_per_hop', reason: `following ${this.program.hops[hop]!.link.apiName} needs ${distinct.length} keys, over the bound of ${limit}; refused rather than split without end`,
        element: { kind: 'link_type', id: this.program.hops[hop]!.link.id, name: this.program.hops[hop]!.link.apiName },
        bound: { name: 'keys_per_hop', limit, observed: distinct.length }, remedy: 'narrow the question so fewer objects are followed',
      });
    }
    return distinct;
  }

  pair(hopIndex: number, fromObjects: MergedObject[], toObjects: MergedObject[]): void {
    const hop = this.program.hops[hopIndex]!;
    const byKey = new Map<string, MergedObject[]>();
    for (const o of toObjects) {
      for (const k of this.keysOf(o, hop.toSource, hop.toField)) {
        const list = byKey.get(String(k)) ?? [];
        if (!list.includes(o)) list.push(o);
        byKey.set(String(k), list);
      }
    }
    for (const o of fromObjects) {
      const linked: MergedObject[] = [];
      for (const k of this.keysOf(o, hop.fromSource, hop.fromField)) {
        for (const t of byKey.get(String(k)) ?? []) if (!linked.includes(t)) linked.push(t);
      }
      const mine = this.links.get(o.id) ?? new Map<number, MergedObject[]>();
      mine.set(hopIndex, linked);
      this.links.set(o.id, mine);
    }
  }

  /** A junction's pairs (from key, to key) for these from keys, read in bounded chunks. */
  async readJunction(hop: Program['hops'][number], keys: Json[]): Promise<[Json, Json][]> {
    const junction = hop.junction!;
    const step = { source: hop.toSource } as SourceStep;
    const pairs: [Json, Json][] = [];
    for (let i = 0; i < keys.length; i += IN_CHUNK) {
      const chunk = keys.slice(i, i + IN_CHUNK) as (string | number | boolean)[];
      let out;
      try {
        out = await this.deps.services.call(readObject, {
          body: {
            connectionId: hop.route.connectionId, reason: 'query',
            step: { object: junction.object, fields: [junction.fromField, junction.toField], filters: [{ field: junction.fromField, op: 'in', value: chunk } as StepFilter] },
          },
        }, { ...callOptions(this.call), signal: this.signal, timeoutMs: this.program.bounds.wallTimeMs });
      } catch (error) {
        const refusal = refusalOfRead(error, step);
        if (refusal !== undefined) throw new Refused(refusal);
        throw error;
      }
      this.bytes += Buffer.byteLength(JSON.stringify(out.rows));
      for (const row of out.rows) {
        const [f, t] = [row[junction.fromField], row[junction.toField]];
        if (f !== null && f !== undefined && t !== null && t !== undefined) pairs.push([f as Json, t as Json]);
      }
    }
    return pairs;
  }

  /** Pairs objects across a junction: each from object to the to objects its keys' pairs name. */
  pairThrough(hopIndex: number, fromObjects: MergedObject[], toObjects: MergedObject[], pairs: readonly [Json, Json][]): void {
    const hop = this.program.hops[hopIndex]!;
    const byKey = new Map<string, MergedObject[]>();
    for (const o of toObjects) {
      for (const k of this.keysOf(o, hop.toSource, hop.toField)) {
        const list = byKey.get(String(k)) ?? [];
        if (!list.includes(o)) list.push(o);
        byKey.set(String(k), list);
      }
    }
    const targets = new Map<string, string[]>();
    for (const [f, t] of pairs) targets.set(String(f), [...(targets.get(String(f)) ?? []), String(t)]);
    for (const o of fromObjects) {
      const linked: MergedObject[] = [];
      for (const k of this.keysOf(o, hop.fromSource, hop.fromField)) {
        for (const t of targets.get(String(k)) ?? []) for (const x of byKey.get(t) ?? []) if (!linked.includes(x)) linked.push(x);
      }
      const mine = this.links.get(o.id) ?? new Map<number, MergedObject[]>();
      mine.set(hopIndex, linked);
      this.links.set(o.id, mine);
    }
  }

  /**
   * Properties computed over links (21.11), once the hidden hops have read the linked objects:
   * the expression gets the object's own inputs and, for each link, the linked objects' declared
   * properties. An input disputed, unchecked or empty, on the object or a linked one, leaves no
   * value (unchecked). Then the node's filters on them apply.
   */
  computeLinked(node: NodeProgram, objects: MergedObject[]): MergedObject[] {
    const computed = [...node.access.properties.values()].filter((p) => p.computed?.links !== undefined && node.reads.has(p.property.identityId));
    for (const p of computed) {
      const spec = p.computed!;
      let program = computeCache.get(spec.functionVersionId);
      if (program === undefined) {
        program = compileCel(spec.expression, { object: 'map', links: 'map', params: 'map', now: 'timestamp' });
        computeCache.set(spec.functionVersionId, program);
      }
      const inputs = spec.inputs.map((id) => node.access.properties.get(id)!);
      for (const o of objects) {
        const object: Record<string, Json> = {};
        const links: Record<string, Json> = {};
        let missing = false;
        for (const input of inputs) {
          const d = o.values.get(input.property.identityId);
          if (d === undefined || undecided(d.state) || d.value === null) { missing = true; break; }
          object[input.property.apiName] = d.value;
        }
        for (const l of spec.links!) {
          if (missing) break;
          const linked = this.links.get(o.id)?.get(node.linkedHops?.get(l.linkTypeId) ?? -1) ?? [];
          links[l.apiName] = linked.map((x) => {
            const values: Record<string, Json> = {};
            for (const lp of l.properties) {
              const d = x.values.get(lp.identityId);
              if (d === undefined || undecided(d.state) || d.value === null) { missing = true; break; }
              values[lp.apiName] = d.value;
            }
            return values;
          });
        }
        if (missing) { o.values.set(p.property.identityId, { value: null, state: 'unchecked' }); continue; }
        try {
          const out = program.evaluate({ object, links, params: {}, now: this.now }, { steps: spec.costLimit, timeMs: COMPUTE_TIME_MS });
          const raw = out instanceof Date ? out.toISOString() : out;
          const value = raw === null || raw === undefined ? null : typed(raw, p.property.dataType, COMPUTED_MAPPING);
          o.values.set(p.property.identityId, value === null ? { value: null, state: 'empty' } : { value, state: 'only' });
        } catch {
          o.values.set(p.property.identityId, { value: null, state: 'unchecked' });
        }
      }
    }
    const deferred = node.filters.filter((f) => f.property.computed?.links !== undefined);
    if (deferred.length === 0) return objects;
    return objects.filter((object) => {
      for (const f of deferred) {
        const decided = object.values.get(f.property.property.identityId) ?? { value: null, state: 'empty' as const };
        if (decided.state === 'disputed') { this.excludedByDispute += 1; return false; }
        if (!satisfies(decided.value, f.op, f.value, f.property.property.dataType)) return false;
      }
      return true;
    });
  }

  /** The hidden hops from a node, followed for these objects (the object view's one object), then its linked computations. */
  async readHidden(node: NodeProgram, objects: MergedObject[]): Promise<MergedObject[]> {
    for (const hop of this.program.hops.filter((h) => h.hidden && h.from === node.node)) {
      const keys = this.boundKeys(objects.flatMap((o) => this.keysOf(o, hop.fromSource, hop.fromField)), hop.index);
      const target = this.program.nodes[hop.to]!;
      if (hop.junction !== undefined) {
        const pairs = keys.length === 0 ? [] : await this.readJunction(hop, keys);
        const toKeys = this.boundKeys(pairs.map(([, t]) => t), hop.index);
        const to = toKeys.length === 0 && target.mode === 'single_source' ? [] : await this.readNode(target, { source: hop.toSource, field: hop.toField, keys: toKeys });
        this.pairThrough(hop.index, objects, to, pairs);
      } else {
        const to = keys.length === 0 && target.mode === 'single_source' ? [] : await this.readNode(target, { source: hop.toSource, field: hop.toField, keys });
        this.pair(hop.index, objects, to);
      }
    }
    return this.computeLinked(node, objects);
  }

  async execute(): Promise<void> {
    if (this.program.warehouseAggregate !== undefined && this.mayPushAggregate && await this.readWarehouseAggregate()) return;
    if (this.program.aggregatePushdown !== undefined && this.mayPushAggregate && await this.readAggregate()) return;
    const { nodes, hops } = this.program;
    const single = hops.length === 1 && hops[0]!.leads === 'to' ? hops[0]! : undefined;
    if (single !== undefined) {
      // The filtered side leads (spec 26.11): read it, then the root by identity on its keys.
      const to = await this.readNode(nodes[single.to]!);
      const keys = this.boundKeys(to.flatMap((o) => this.keysOf(o, single.toSource, single.toField)), 0);
      const from = keys.length === 0 ? [] : await this.readNode(nodes[single.from]!, { source: single.fromSource, field: single.fromField, keys });
      this.population[single.from] = from;
      this.population[single.to] = to;
      this.pair(0, from, to);
    } else {
      this.population[0] = await this.readNode(nodes[0]!);
      if (this.program.history !== undefined) await this.readHistory(this.population[0]);
      for (const hop of hops) {
        const from = this.population[hop.from]!;
        const keys = this.boundKeys(from.flatMap((o) => this.keysOf(o, hop.fromSource, hop.fromField)), hop.index);
        const target = nodes[hop.to]!;
        if (hop.junction !== undefined) {
          // Through the junction (21.8): its pairs for the from side's keys, then the to side by the keys they name.
          const pairs = keys.length === 0 ? [] : await this.readJunction(hop, keys);
          const toKeys = this.boundKeys(pairs.map(([, t]) => t), hop.index);
          const to = toKeys.length === 0 && target.mode === 'single_source' ? []
            : await this.readNode(target, { source: hop.toSource, field: hop.toField, keys: toKeys });
          this.population[hop.to] = to;
          this.pairThrough(hop.index, from, to, pairs);
          continue;
        }
        const to = keys.length === 0 && target.mode === 'single_source' ? []
          : await this.readNode(target, { source: hop.toSource, field: hop.toField, keys });
        this.population[hop.to] = to;
        this.pair(hop.index, from, to);
      }
    }
    // Properties computed over links, now their linked objects are read (21.11), and the filters on them.
    for (const n of nodes) {
      if (!n.hidden && this.population[n.node] !== undefined) this.population[n.node] = this.computeLinked(n, this.population[n.node]!);
    }
    // A filtered linked node narrows its parent to the objects that reach it, deepest first.
    const narrows = nodes.map((n) => n.restricted);
    for (const hop of [...hops].sort((a, b) => b.index - a.index)) {
      if (narrows[hop.to]) narrows[hop.from] = true;
    }
    for (const hop of [...hops].sort((a, b) => b.index - a.index)) {
      const alive = new Set(this.population[hop.to]!.map((o) => o.id));
      this.population[hop.from] = this.population[hop.from]!.filter((o) => {
        const mine = this.links.get(o.id);
        const linked = (mine?.get(hop.index) ?? []).filter((t) => alive.has(t.id));
        mine?.set(hop.index, linked);
        return !narrows[hop.to] || linked.length > 0;
      });
    }
  }

  /** The hops below a node, for building nested objects: a hidden hop is never shown. */
  childHops(node: number) {
    return this.program.hops.filter((h) => h.from === node && !h.hidden);
  }

  shownProperties(node: number): PropertyAccess[] {
    const access = this.program.nodes[node]!.access;
    const chosen = this.program.plan.select.filter((s) => s.node === node).map((s) => access.properties.get(s.property)!);
    if (chosen.length > 0) return chosen;
    const title = access.properties.get(access.type.titlePropertyIdentityId);
    return title === undefined ? [] : [title];
  }

  objectView(object: MergedObject, node: number): ResultObject {
    const values: Record<string, Json> = {};
    const states: Record<string, ResultObject['states'][string]> = {};
    const disputed: string[] = [];
    const maskedNames: string[] = [];
    const redacted: string[] = [];
    for (const p of this.shownProperties(node)) {
      const s = show(object, p);
      values[p.property.apiName] = s.value;
      states[p.property.apiName] = (object.values.get(p.property.identityId) ?? { state: 'empty' as const }).state;
      if (s.disputed) disputed.push(p.property.apiName);
      if (s.masked) maskedNames.push(p.property.apiName);
      if (s.redacted) redacted.push(p.property.apiName);
    }
    const links: Record<string, ResultObject[]> = {};
    for (const hop of this.childHops(node)) {
      const linked = this.links.get(object.id)?.get(hop.index) ?? [];
      links[String(hop.index)] = [...linked].sort((a, b) => (a.id < b.id ? -1 : 1)).map((t) => this.objectView(t, hop.to));
    }
    const view: ResultObject = { id: object.id, objectTypeId: object.typeId, values, states, disputed, masked: maskedNames, redacted, unmatched: object.unmatched, links };
    // The source records it was merged from, by identifier, where the caller acts on them (40.5).
    if (this.references && node === 0) {
      view.records = object.records.map((r) => ({
        connectionId: r.source.connectionId, sourceObject: r.source.sourceObject, reference: String(r.row[r.source.identifierFieldPath] ?? ''),
      })).filter((r) => r.reference !== '');
    }
    if (node === 0 && this.program.history !== undefined) {
      // Each change to a shown property, under the reader's field policy as the values are.
      const shown = new Map(this.shownProperties(0).map((p) => [p.property.apiName, p]));
      view.changes = (this.changes.get(object.id) ?? []).filter((c) => shown.has(c.property)).map((c) => {
        const p = shown.get(c.property)!;
        if (p.effect === 'redact') return { property: c.property, at: c.at, previous: null, value: null, withheld: 'redact' as const };
        if (p.effect === 'mask') return { property: c.property, at: c.at, previous: masked(c.previous), value: masked(c.value), withheld: 'mask' as const };
        return { property: c.property, at: c.at, previous: c.previous, value: c.value };
      });
    }
    return view;
  }

  /** Objects reachable at a node from a set of root objects, each once. */
  reachable(roots: MergedObject[], node: number): MergedObject[] {
    if (node === 0) return roots;
    const path: number[] = [];
    let at = node;
    while (at !== 0) {
      const hop = this.program.hops.find((h) => h.to === at)!;
      path.unshift(hop.index);
      at = hop.from;
    }
    let current = roots;
    for (const index of path) {
      const seen = new Map<string, MergedObject>();
      for (const o of current) for (const t of this.links.get(o.id)?.get(index) ?? []) seen.set(t.id, t);
      current = [...seen.values()];
    }
    return current;
  }

  routeTo(node: number): { linkTypeId: string; routeId: string }[] {
    const out: { linkTypeId: string; routeId: string }[] = [];
    let at = node;
    while (at !== 0) {
      const hop = this.program.hops.find((h) => h.to === at)!;
      out.unshift({ linkTypeId: hop.link.id, routeId: hop.route.id });
      at = hop.from;
    }
    return out;
  }

  lineageOf(node: number, p: PropertyAccess): ColumnLineage {
    const program = this.program;
    const n = program.nodes[node]!;
    // A computed property's lineage is its inputs' (spec 59): the systems and fields it was computed from.
    const mappedFrom = p.computed === undefined ? [p] : p.computed.inputs.map((id) => n.access.properties.get(id)!).filter((x) => x !== undefined);
    const objects = this.population[node] ?? [];
    let values = 0;
    let empty = 0;
    let disputed = 0;
    let unchecked = 0;
    if (this.pushed !== undefined) {
      // Counted where computed: values where the property is not null, disputed where flagged (the Warehouse; a single source disputes nothing), the rest empty.
      values = this.pushed.counts.get(p.property.identityId) ?? 0;
      disputed = this.pushed.disputed?.get(p.property.identityId) ?? 0;
      empty = this.pushed.rows - values - disputed;
    }
    for (const o of objects) {
      const d = o.values.get(p.property.identityId);
      if (d === undefined || d.state === 'empty') empty += 1;
      else if (d.state === 'disputed') disputed += 1;
      else if (d.state === 'unchecked') unchecked += 1;
      else values += 1;
    }
    return {
      node, objectTypeVersionId: n.access.type.typeVersionId, ontologyVersionId: program.manifest.version.id, branchId: program.manifest.version.branchId,
      propertyIdentityId: p.property.identityId, propertyApiName: p.property.apiName,
      sources: n.sources.flatMap((step) => mappedFrom.flatMap((input) => {
        const m = input.property.mappings.find((x) => x.connectionId === step.source.connectionId && x.sourceObject === step.source.sourceObject);
        if (m === undefined) return [];
        return [{
          connectionId: step.source.connectionId, connectorVersion: step.source.connectorVersion, sourceObject: step.source.sourceObject,
          fieldPath: m.fieldPath, readAt: this.readAt.get(step) ?? new Date().toISOString(),
          pushdown: { filter: this.pushedFilter.has(step), sort: false, aggregate: this.pushed !== undefined },
        }];
      })),
      ...(n.period === undefined ? {} : { period: n.period }),
      // Who answered (69.6): the Object Index as of its last refresh, or the Warehouse as of the instant asked, where one did.
      ...(this.servedBy.has(node) ? { servedBy: this.servedBy.get(node)! } : {}),
      // A split plan's set, from the Object Index as of its refresh: the values are live (readAt), the membership is not.
      ...(this.narrowedBy.has(node) ? { narrowedBy: this.narrowedBy.get(node)! } : {}),
      route: this.routeTo(node),
      coverage: { values, empty, disputed, unchecked, masked: p.effect === 'mask' ? values : 0, redacted: p.effect === 'redact' ? values : 0 },
    };
  }

  groups(): ResultGroup[] {
    if (this.pushed !== undefined) return this.pushed.groups;
    const plan = this.program.plan;
    const aggregate = plan.aggregate!;
    const root = this.program.nodes[0]!.access;
    const keyProps = aggregate.groupBy.map((g) => root.properties.get(g.property)!);
    const calendar = this.program.calendar;
    const buckets = new Map<string, { key: Record<string, Json>; roots: MergedObject[] }>();
    for (const o of this.population[0]!) {
      const key: Record<string, Json> = {};
      let undecidedKey = false;
      keyProps.forEach((p, i) => {
        const d = o.values.get(p.property.identityId) ?? { value: null, state: 'empty' as const };
        if (d.state === 'disputed' || d.state === 'unchecked') undecidedKey = true;
        // A time bucket (37.8): the first day of the period containing the value, in the organisation's calendar.
        const unit = aggregate.groupBy[i]!.bucket;
        key[p.property.apiName] = unit !== undefined && typeof d.value === 'string'
          ? bucketStart(d.value, p.property.dataType === 'date' ? 'date' : 'timestamp', unit, calendar) ?? null
          : d.value;
      });
      if (undecidedKey) {
        this.excludedByDispute += 1;
        continue;
      }
      const id = JSON.stringify(keyProps.map((p) => key[p.property.apiName]));
      const bucket = buckets.get(id) ?? { key, roots: [] };
      bucket.roots.push(o);
      buckets.set(id, bucket);
    }
    return [...buckets.values()].map(({ key, roots }) => {
      const measures: Record<string, number | null> = {};
      const excluded: Record<string, number> = {};
      for (const m of aggregate.measures) {
        const objects = this.reachable(roots, m.node);
        if (m.property === undefined) {
          measures[m.as] = objects.length;
          excluded[m.as] = 0;
          continue;
        }
        const p = this.program.nodes[m.node]!.access.properties.get(m.property)!;
        const decided: Json[] = [];
        let left = 0;
        for (const o of objects) {
          const d = o.values.get(p.property.identityId);
          if (d === undefined || undecided(d.state) || d.value === null) left += 1;
          else decided.push(d.value);
        }
        excluded[m.as] = left;
        const numbers = decided.filter((v): v is number => typeof v === 'number');
        switch (m.fn) {
          case 'count': measures[m.as] = decided.length; break;
          case 'count_distinct': measures[m.as] = new Set(decided.map((v) => JSON.stringify(v))).size; break;
          case 'sum': measures[m.as] = numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0); break;
          case 'avg': measures[m.as] = numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0) / numbers.length; break;
          case 'min':
          case 'max': {
            if (decided.length === 0) { measures[m.as] = null; break; }
            const sorted = [...decided].sort((a, b) => compareTyped(a, b, p.property.dataType));
            const pick = m.fn === 'min' ? sorted[0]! : sorted.at(-1)!;
            measures[m.as] = typeof pick === 'number' ? pick : p.property.dataType === 'timestamp' ? Date.parse(pick as string)
              : p.property.dataType === 'date' ? Date.parse(`${pick as string}T00:00:00Z`) : null;
            break;
          }
        }
      }
      return { key, measures, objects: roots.length, excluded };
    });
  }

  build(queryId: string, planHash: string): { header: Omit<QueryResult, 'page' | 'cached'>; items: (ResultObject | ResultGroup)[] } {
    const { plan, nodes } = this.program;
    const root = nodes[0]!.access;
    const population = this.pushed?.rows ?? this.population[0]!.length;
    let items: (ResultObject | ResultGroup)[];
    let kind: QueryResult['kind'];
    const columns: QueryResult['columns'] = [];
    const lineage: ColumnLineage[] = [];

    if (plan.aggregate !== undefined) {
      kind = 'groups';
      let groups = this.groups();
      const keyType = (property: string) => root.properties.get(property)!.property;
      groups = orderBy(groups, plan.sort.map((s) => s.property !== undefined
        ? { get: (g: ResultGroup) => ({ value: g.key[keyType(s.property!).apiName] ?? null, undecided: false }), type: keyType(s.property).dataType, desc: s.direction === 'desc' }
        : { get: (g: ResultGroup) => ({ value: g.measures[s.measure!] ?? null, undecided: false }), type: 'decimal' as const, desc: s.direction === 'desc' }),
      (g) => JSON.stringify(g.key));
      items = plan.limit === undefined ? groups : groups.slice(0, plan.limit);
      for (const g of plan.aggregate.groupBy) {
        const p = root.properties.get(g.property)!;
        // A bucketed key is the first day of its period: a date, whatever the property's own type.
        columns.push({ node: 0, property: p.property.identityId, apiName: p.property.apiName, displayName: p.property.displayName, dataType: g.bucket !== undefined ? 'date' : p.property.dataType, effect: p.effect });
        lineage.push(this.lineageOf(0, p));
      }
      for (const m of plan.aggregate.measures) {
        if (m.property === undefined) continue;
        lineage.push(this.lineageOf(m.node, nodes[m.node]!.access.properties.get(m.property)!));
      }
    } else {
      kind = 'objects';
      const sortKeys = plan.sort.map((s) => {
        const p = root.properties.get(s.property!)!;
        return {
          get: (o: MergedObject) => {
            const d = o.values.get(p.property.identityId) ?? { value: null, state: 'empty' as const };
            return { value: d.value, undecided: undecided(d.state) };
          },
          type: p.property.dataType, desc: s.direction === 'desc',
        };
      });
      const ordered = orderBy(this.population[0]!, sortKeys, (o) => o.id);
      const limited = plan.limit === undefined ? ordered : ordered.slice(0, plan.limit);
      items = limited.map((o) => this.objectView(o, 0));
      for (const n of nodes) {
        if (n.hidden) continue;
        for (const p of this.shownProperties(n.node)) {
          columns.push({ node: n.node, property: p.property.identityId, apiName: p.property.apiName, displayName: p.property.displayName, dataType: p.property.dataType, effect: p.effect });
          lineage.push(this.lineageOf(n.node, p));
        }
      }
    }
    if (items.length > this.program.bounds.mergedResult) {
      throw new Refused({
        code: 'query.bound_merged_result', reason: `the answer has ${items.length} ${kind}, more than one answer may cover (${this.program.bounds.mergedResult}); refused, never truncated`,
        bound: { name: 'merged_result', limit: this.program.bounds.mergedResult, observed: items.length },
        remedy: 'narrow the question, or ask for the top few with a limit',
      });
    }

    const disputed: Record<string, number> = {};
    const empty: Record<string, number> = {};
    const unchecked: Record<string, number> = {};
    for (const p of this.shownProperties(0)) {
      const l = lineage.find((x) => x.node === 0 && x.propertyIdentityId === p.property.identityId) ?? this.lineageOf(0, p);
      disputed[p.property.apiName] = l.coverage.disputed;
      empty[p.property.apiName] = l.coverage.empty;
      unchecked[p.property.apiName] = l.coverage.unchecked;
    }
    return {
      header: {
        queryId, planHash, ontologyVersionId: this.program.manifest.version.id, kind, columns,
        measures: (plan.aggregate?.measures ?? []).map((m) => ({ as: m.as, fn: m.fn, node: m.node, ...(m.property === undefined ? {} : { property: m.property }) })),
        population, total: items.length,
        coverage: {
          objects: population, unmatched: this.population[0]!.filter((o) => o.unmatched).length, disputed, empty, unchecked,
          excludedByDispute: this.excludedByDispute,
        },
        lineage, periods: this.program.periods,
        localFilters: nodes.flatMap((n) => n.sources.flatMap((s) => s.local.map((f) => ({ node: n.node, connectionId: s.source.connectionId, field: f.field, op: f.op })))),
        reduced: columns.some((c) => c.effect !== 'allow'),
        aggregateForm: plan.aggregate === undefined ? null : this.servedBy.get(0)?.kind === 'warehouse' ? 'warehouse' : this.pushed !== undefined ? 'partial_pushdown' : 'merged',
        defaults: this.program.defaults,
        ...(this.program.manifest.version.branchKind === 'main' ? {} : {
          branch: { branchId: this.program.manifest.version.branchId, kind: this.program.manifest.version.branchKind },
        }),
        computedAt: new Date().toISOString(),
        ...(this.program.history === undefined ? {} : {
          history: {
            asWritten: this.program.history.asWritten, from: this.program.history.from, to: this.program.history.to, source: 'warehouse' as const,
            watermark: this.program.nodes[0]!.warehouse!.watermark,
          },
        }),
      },
      items,
    };
  }
}

const hashOf = (value: unknown): string => sha256(canonicalJsonBytes(value)).toString('hex');

/** Runs a plan: an answer or a refusal, each a finished reply (spec 26.9, 27.8). */
export async function runPlan(deps: ExecutorDeps, call: PlanCall & { signal: AbortSignal }, input: RunInput): Promise<RunOutcome> {
  // Over an interface (21.9): one run per implementing type, combined into one answer.
  if (isInterfacePlan(input.plan)) return runInterfacePlan(deps, call, input, runPlan);
  const request = call.request;
  const refused = async (refusal: Refusal): Promise<RunOutcome> => {
    const event = refusal.code === 'query.source_unavailable' ? 'query_refused_source_unavailable' as const
      : refusal.bound !== undefined ? 'query_refused_bounds' as const : undefined;
    if (event !== undefined) {
      await recordQueryEvent(deps.databases, request, call.correlationId, event, {
        code: refusal.code, ...(refusal.bound ? { bound: refusal.bound.name, limit: refusal.bound.limit } : {}),
        ...(refusal.element?.kind === 'connection' && refusal.element.id ? { connection_id: refusal.element.id } : {}),
      }, input.planId);
    }
    return { outcome: 'refusal', refusal };
  };

  // An Explorer facet's counts may come from a fresh Object Index (69.3); every other aggregate reads the sources or the Warehouse.
  const program = await buildProgram(deps, call, input.plan, input.parameters, input.trigger === 'explorer_facet' ? { facet: true } : {});
  if (isRefusal(program)) return refused(program);
  for (const id of input.keep?.properties ?? []) {
    const p = program.nodes[0]!.access.properties.get(id);
    if (p === undefined || p.effect !== 'allow') {
      return refused({
        code: 'query.object_set_field', reason: 'the set\'s definition reads a property you may not see plainly, so its members cannot be decided for you',
        element: { kind: 'property', id }, remedy: 'ask the set\'s owner, or an administrator, about your access',
      });
    }
  }
  const planHash = hashOf({ plan: input.plan, parameters: input.parameters, ...(input.keep ? { keep: input.keep.hash } : {}), ...(input.references ? { references: true } : {}) });
  // The change epochs are read before any source is, so a change during the run leaves the
  // kept entry stale for the next request rather than fresh.
  const epochs = await deps.results.epochs(request.organisationId!, program.nodes.flatMap((n) => n.sources.map((s) => ({
    connectionId: s.source.connectionId, sourceObject: s.source.sourceObject,
  }))));
  const cache: CacheParts = {
    planHash, ontologyVersion: program.manifest.version.id,
    periodResolution: hashOf(program.periods.map((p) => [p.node, p.property, p.from, p.to])),
    permissionFingerprint: program.access.fingerprint, epochs,
  };
  const executed = async (result: QueryResult) => {
    await recordQueryEvent(deps.databases, request, call.correlationId, 'query_executed', {
      query_id: result.queryId, plan_hash: planHash, ontology_version_id: result.ontologyVersionId, kind: result.kind,
      population: result.population, total: result.total, cached: result.cached, trigger: input.trigger,
      sources: program.nodes.reduce((n, node) => n + node.sources.length, 0), hops: program.hops.length,
    }, input.planId);
    if (!result.cached) {
      // Each column's systems and fields, by reference: the answer's lineage (27.12, 59).
      const sources = result.lineage.flatMap((l) => l.sources);
      await recordQueryEvent(deps.databases, request, call.correlationId, 'lineage_recorded', {
        query_id: result.queryId, columns: result.lineage.length, connections: new Set(sources.map((x) => x.connectionId)).size,
        source_objects: new Set(sources.map((x) => `${x.connectionId}/${x.sourceObject}`)).size,
        served_by_index: result.lineage.some((l) => l.servedBy?.kind === 'index'), served_by_warehouse: result.lineage.some((l) => l.servedBy?.kind === 'warehouse'),
      }, input.planId);
    }
    if (!result.cached && result.aggregateForm === 'partial_pushdown') {
      await recordQueryEvent(deps.databases, request, call.correlationId, 'aggregate_partial_pushdown_used', {
        query_id: result.queryId, connection_id: program.nodes[0]!.sources[0]!.source.connectionId, groups: result.total,
      }, input.planId);
    }
    if (!result.cached && result.localFilters.length > 0) {
      await recordQueryEvent(deps.databases, request, call.correlationId, 'pushdown_local_filter_applied', {
        query_id: result.queryId, filters: result.localFilters.length,
      }, input.planId);
    }
  };

  if (input.useCache) {
    const hit = await deps.results.cached(request, cache);
    if (hit !== undefined) {
      await executed(hit);
      return { outcome: 'answer', result: hit };
    }
  }

  const queryId = uuidv7();
  const slot = await deps.results.slot(request.organisationId!, queryId, deps.bounds.concurrentPlansPerOrganisation, deps.bounds.wallTimeMs + 5_000);
  if (slot === undefined) {
    return refused({
      code: 'query.bound_concurrent_plans', reason: `the organisation already has ${deps.bounds.concurrentPlansPerOrganisation} questions running`,
      bound: { name: 'concurrent_plans', limit: deps.bounds.concurrentPlansPerOrganisation }, remedy: 'try again in a moment',
    });
  }
  try {
    const signal = AbortSignal.any([call.signal, AbortSignal.timeout(deps.bounds.wallTimeMs)]);
    // A saved set's membership test needs each object, so its aggregate is always over merged objects.
    const run = new Run(deps, call, program, signal, { mayPushAggregate: input.keep === undefined, references: input.references === true });
    let built;
    try {
      await run.execute();
      if (input.keep !== undefined) {
        const keep = input.keep;
        const root = program.nodes[0]!.access;
        run.population[0] = run.population[0]!.filter((o) => {
          const subject: Record<string, Json | null> = {};
          for (const id of keep.properties) {
            const d = o.values.get(id);
            subject[root.properties.get(id)!.property.apiName] = d === undefined || undecided(d.state) ? null : d.value;
          }
          return keep.test(subject, o.id);
        });
      }
      built = run.build(queryId, planHash);
    } catch (error) {
      if (error instanceof Refused) return refused(error.refusal);
      if (signal.aborted && !call.signal.aborted) {
        return refused({ code: 'query.bound_wall_time', reason: 'the question ran past its time bound; refused rather than answered in part', bound: { name: 'wall_time', limit: deps.bounds.wallTimeMs } });
      }
      throw error;
    }
    const result = await deps.results.keep(request, built.header, built.items, cache);
    captureAnswer(deps, request, built);
    await executed(result);
    return { outcome: 'answer', result };
  } finally {
    await slot.release();
  }
}

/** A further page of a result, for its own actor. */
/** The result again, header and first page, for its own actor while it lives (spec 31.2). */
export async function readResult(deps: ExecutorDeps, call: PlanCall, queryId: string): Promise<QueryResult> {
  const read = await deps.results.page(call.request, queryId, 0);
  if (read === undefined) {
    throw new AppError('not_found', 'that result has expired or is not yours; run the question again', { code: 'query.result_gone' });
  }
  const { pageCount, ...header } = read.header;
  return { ...header, cached: true, page: pageOf(header.kind, 0, pageCount, read.items) };
}

export async function readPage(deps: ExecutorDeps, call: PlanCall, queryId: string, index: number) {
  const read = await deps.results.page(call.request, queryId, index);
  if (read === undefined) {
    throw new AppError('not_found', 'that result has expired or is not yours; run the question again', { code: 'query.result_gone' });
  }
  return {
    queryId, index, count: read.header.pageCount,
    objects: read.header.kind === 'objects' ? read.items as ResultObject[] : [],
    groups: read.header.kind === 'groups' ? read.items as ResultGroup[] : [],
  };
}
