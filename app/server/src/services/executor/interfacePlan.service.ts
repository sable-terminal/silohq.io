// Running a plan over an interface (spec 21.9): one sub-plan per implementing type the reader
// may see, each the engine's own run under the reader's access, bounds and refusals, combined
// into one answer that states which types contributed and how many objects each.
//
// - Objects keep their own type; their values are named by the interface's shared
//   properties. They are ordered across types by the plan's sort (disputed and empty last,
//   27.6), then cut to its limit: each sub-plan is cut to the same limit first, which keeps
//   every object the whole answer could hold.
// - Groups are keyed by the shared properties' values and combined exactly: counts and sums
//   add, a minimum or maximum is the least or greatest of the types', an average is the
//   types' averages weighted by how many values each measured. A distinct count over more than
//   one type cannot be combined exactly (the same value may be in both), so it is refused.
//   Sub-plans are not sorted or limited: the order and the limit apply to the combined groups.
// A type the reader may not see contributes nothing and is not named. Any other refusal of a
// sub-plan refuses the whole: an answer is never made from some of the types.

import type { QueryResult, ResultGroup, ResultObject, RunOutcome } from '../../contracts/executor/result.contract.ts';
import type { Refusal } from '../../contracts/planner/plan.contract.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { isRefusal } from '../planner/access.service.ts';
import type { PlanCall } from '../planner/deps.service.ts';
import { expandInterfacePlan, UNSEEN_TYPE } from '../planner/interfacePlans.service.ts';
import type { ExecutorDeps, RunInput } from './execute.service.ts';
import { compareTyped, type Json } from './values.service.ts';

type Call = PlanCall & { signal: AbortSignal };
type Run = (deps: ExecutorDeps, call: Call, input: RunInput) => Promise<RunOutcome>;

const hashOf = (value: unknown): string => sha256(canonicalJsonBytes(value)).toString('hex');

/** Every object of an answer, all its pages. Undefined: a page expired while it was read. */
async function everyObject(deps: ExecutorDeps, call: Call, result: QueryResult): Promise<ResultObject[] | undefined> {
  const out = [...result.page.objects];
  for (let i = 1; i < result.page.count; i += 1) {
    const read = await deps.results.page(call.request, result.queryId, i);
    if (read === undefined) return undefined;
    out.push(...read.items as ResultObject[]);
  }
  return out;
}

async function everyGroup(deps: ExecutorDeps, call: Call, result: QueryResult): Promise<ResultGroup[] | undefined> {
  const out = [...result.page.groups];
  for (let i = 1; i < result.page.count; i += 1) {
    const read = await deps.results.page(call.request, result.queryId, i);
    if (read === undefined) return undefined;
    out.push(...read.items as ResultGroup[]);
  }
  return out;
}

const renamed = (record: Record<string, Json>, names: Map<string, string>): Record<string, Json> =>
  Object.fromEntries(Object.entries(record).flatMap(([k, v]) => (names.has(k) ? [[names.get(k)!, v]] : [])));

/** Undecided values sort last in either direction (27.6); then by the tie. */
function ordered<T>(items: T[], keys: { get: (item: T) => Json | null; type: Parameters<typeof compareTyped>[2]; desc: boolean }[], tie: (item: T) => string): T[] {
  return items.map((item) => ({ item, at: keys.map((k) => k.get(item)) })).sort((a, b) => {
    for (const [i, k] of keys.entries()) {
      const [x, y] = [a.at[i] ?? null, b.at[i] ?? null];
      if ((x === null) !== (y === null)) return x === null ? 1 : -1;
      if (x === null || y === null) continue;
      const c = compareTyped(x, y, k.type);
      if (c !== 0) return k.desc ? -c : c;
    }
    return tie(a.item) < tie(b.item) ? -1 : tie(a.item) > tie(b.item) ? 1 : 0;
  }).map((e) => e.item);
}

const gone: Refusal = { code: 'query.result_gone', reason: 'a part of the answer expired while it was combined; run it again' };

export async function runInterfacePlan(deps: ExecutorDeps, call: Call, input: RunInput, run: Run): Promise<RunOutcome> {
  const expanded = await expandInterfacePlan(deps, call, input.plan);
  if (isRefusal(expanded)) return { outcome: 'refusal', refusal: expanded };
  const { iface, shared, types } = expanded;
  const plan = input.plan;
  const aggregate = plan.aggregate;

  const results: { objectTypeId: string; names: Map<string, string>; result: QueryResult }[] = [];
  for (const t of types) {
    // Groups combine across types before they are ordered and cut.
    const typePlan = aggregate === undefined ? t.plan : { ...t.plan, sort: [], limit: undefined };
    const outcome = await run(deps, call, { ...input, plan: typePlan });
    if (outcome.outcome === 'refusal') {
      if (UNSEEN_TYPE.has(outcome.refusal.code)) continue;
      return outcome;
    }
    results.push({ objectTypeId: t.objectTypeId, names: t.names, result: outcome.result });
  }
  if (aggregate !== undefined && results.length > 1 && aggregate.measures.some((m) => m.fn === 'count_distinct')) {
    return { outcome: 'refusal', refusal: {
      code: 'plan.measure_across_types', reason: `a distinct count over ${iface.apiName} cannot be combined across its types exactly: the same value may be in more than one`,
      element: { kind: 'interface', id: iface.id, name: iface.apiName }, remedy: 'count distinct values of one type, or count objects instead',
    } };
  }

  const sharedName = (id: string) => shared.get(id)!.apiName;
  const sharedType = (id: string) => shared.get(id)!.dataType;
  let items: (ResultObject | ResultGroup)[];
  const contributing: { objectTypeId: string; objects: number }[] = [];
  if (aggregate === undefined) {
    const objects: ResultObject[] = [];
    for (const r of results) {
      const all = await everyObject(deps, call, r.result);
      if (all === undefined) return { outcome: 'refusal', refusal: gone };
      contributing.push({ objectTypeId: r.objectTypeId, objects: r.result.population });
      const named = (list: string[]) => list.flatMap((n) => (r.names.has(n) ? [r.names.get(n)!] : []));
      for (const o of all) {
        objects.push({
          ...o, values: renamed(o.values, r.names), states: renamed(o.states as Record<string, Json>, r.names) as ResultObject['states'],
          disputed: named(o.disputed), masked: named(o.masked), redacted: named(o.redacted), links: {},
        });
      }
    }
    const sorted = ordered(objects, plan.sort.map((s) => ({
      get: (o: ResultObject) => {
        const name = sharedName(s.property!);
        const state = o.states[name];
        return state === 'disputed' || state === 'unchecked' || state === 'empty' ? null : (o.values[name] ?? null);
      },
      type: sharedType(s.property!), desc: s.direction === 'desc',
    })), (o) => o.id);
    items = plan.limit === undefined ? sorted : sorted.slice(0, plan.limit);
  } else {
    const buckets = new Map<string, { key: Record<string, Json>; objects: number; parts: { measures: Record<string, number | null>; excluded: Record<string, number>; objects: number }[] }>();
    const keyNames = aggregate.groupBy.map((g) => sharedName(g.property));
    for (const r of results) {
      const groups = await everyGroup(deps, call, r.result);
      if (groups === undefined) return { outcome: 'refusal', refusal: gone };
      contributing.push({ objectTypeId: r.objectTypeId, objects: r.result.population });
      for (const g of groups) {
        const key = renamed(g.key, r.names);
        const id = JSON.stringify(keyNames.map((n) => key[n] ?? null));
        const bucket = buckets.get(id) ?? { key, objects: 0, parts: [] };
        bucket.objects += g.objects;
        bucket.parts.push({ measures: g.measures, excluded: g.excluded, objects: g.objects });
        buckets.set(id, bucket);
      }
    }
    const groups: ResultGroup[] = [...buckets.values()].map((b) => {
      const measures: Record<string, number | null> = {};
      const excluded: Record<string, number> = {};
      for (const m of aggregate.measures) {
        excluded[m.as] = b.parts.reduce((t, p) => t + (p.excluded[m.as] ?? 0), 0);
        const values = b.parts.map((p) => ({ value: p.measures[m.as] ?? null, measured: p.objects - (p.excluded[m.as] ?? 0) }))
          .filter((v): v is { value: number; measured: number } => v.value !== null);
        if (values.length === 0) { measures[m.as] = m.fn === 'count' ? 0 : null; continue; }
        switch (m.fn) {
          case 'count':
          case 'count_distinct':
          case 'sum': measures[m.as] = values.reduce((t, v) => t + v.value, 0); break;
          case 'min': measures[m.as] = Math.min(...values.map((v) => v.value)); break;
          case 'max': measures[m.as] = Math.max(...values.map((v) => v.value)); break;
          case 'avg': {
            const n = values.reduce((t, v) => t + v.measured, 0);
            measures[m.as] = n === 0 ? null : values.reduce((t, v) => t + v.value * v.measured, 0) / n;
            break;
          }
        }
      }
      return { key: b.key, measures, objects: b.objects, excluded };
    });
    const sorted = ordered(groups, plan.sort.map((s) => (s.property !== undefined
      ? { get: (g: ResultGroup) => g.key[sharedName(s.property!)] ?? null, type: sharedType(s.property), desc: s.direction === 'desc' }
      : { get: (g: ResultGroup) => g.measures[s.measure!] ?? null, type: 'decimal' as const, desc: s.direction === 'desc' })), (g) => JSON.stringify(g.key));
    items = plan.limit === undefined ? sorted : sorted.slice(0, plan.limit);
  }

  const bound = deps.bounds.maxResultRows;
  if (items.length > bound) {
    return { outcome: 'refusal', refusal: {
      code: 'query.bound_merged_result', reason: `the answer has ${items.length} ${aggregate === undefined ? 'objects' : 'groups'}, more than one answer may cover (${bound}); refused, never truncated`,
      bound: { name: 'merged_result', limit: bound, observed: items.length }, remedy: 'narrow the question, or ask for the top few with a limit',
    } };
  }

  // Columns are the interface's shared properties, each shown at the strictest effect any type showed it with.
  const rank = { allow: 0, mask: 1, redact: 2 } as const;
  const columns = new Map<string, QueryResult['columns'][number]>();
  for (const r of results) {
    for (const c of r.result.columns) {
      const name = r.names.get(c.apiName);
      const property = [...shared.values()].find((s) => s.apiName === name);
      if (property === undefined) continue;
      const known = columns.get(property.id);
      if (known === undefined || rank[c.effect] > rank[known.effect]) {
        columns.set(property.id, { ...c, property: property.id, apiName: property.apiName, displayName: property.displayName, dataType: property.dataType });
      }
    }
  }
  const sum = (pick: (r: QueryResult) => Record<string, number>, names: Map<string, string>[] = results.map((r) => r.names)) => {
    const out: Record<string, number> = {};
    results.forEach((r, i) => {
      for (const [k, v] of Object.entries(pick(r.result))) {
        const name = names[i]!.get(k);
        if (name !== undefined) out[name] = (out[name] ?? 0) + v;
      }
    });
    return out;
  };
  const population = results.reduce((t, r) => t + r.result.population, 0);
  const forms = new Set(results.map((r) => r.result.aggregateForm));
  const result = await deps.results.keep(call.request, {
    queryId: uuidv7(), planHash: hashOf({ plan, parameters: input.parameters }), ontologyVersionId: plan.ontologyVersionId,
    kind: aggregate === undefined ? 'objects' : 'groups', columns: [...columns.values()],
    measures: (aggregate?.measures ?? []).map((m) => ({ as: m.as, fn: m.fn, node: 0, ...(m.property === undefined ? {} : { property: m.property }) })),
    population, total: items.length,
    coverage: {
      objects: population, unmatched: results.reduce((t, r) => t + r.result.coverage.unmatched, 0),
      disputed: sum((r) => r.coverage.disputed), empty: sum((r) => r.coverage.empty), unchecked: sum((r) => r.coverage.unchecked),
      excludedByDispute: results.reduce((t, r) => t + r.result.coverage.excludedByDispute, 0),
    },
    lineage: results.flatMap((r) => r.result.lineage), periods: results.flatMap((r) => r.result.periods),
    localFilters: results.flatMap((r) => r.result.localFilters), reduced: results.some((r) => r.result.reduced),
    // One form where every type's answer took it; merged otherwise.
    aggregateForm: aggregate === undefined ? null : forms.size === 1 ? [...forms][0]! : 'merged',
    defaults: { timeFields: results.flatMap((r) => r.result.defaults.timeFields), routes: [] },
    contributingTypes: contributing,
    ...(expanded.manifest.version.branchKind === 'main' ? {} : {
      branch: { branchId: expanded.manifest.version.branchId, kind: expanded.manifest.version.branchKind },
    }),
    computedAt: new Date().toISOString(),
  }, items, undefined);
  return { outcome: 'answer', result };
}
