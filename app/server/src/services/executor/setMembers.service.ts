// Object sets the engine walks itself (spec 21.9, 24.4): a set over an interface, a traversal
// and a set operation. Each is answered as one result, every page of it kept as any answer is.
//
// - Interface: one sub-plan per implementing type the reader may see (spec 21.9: "evaluation
//   expands it to one sub-plan per implementing type"); objects keep their own type, their
//   values are named by the interface's shared properties, and the result states which types
//   contributed and how many objects each. Two objects of different types are never one.
// - Traversal: the start (a type with its predicate, or a saved set), then each hop by its
//   route (or the link's default; with several routes and no default, the set says which is
//   needed); the members are the distinct objects at the end of the path.
// - Composite: union, intersection or difference of saved sets of one type or interface, by
//   Silo object id; nested sets are walked to a depth of five.
//
// Every sub-run is the engine's own: the reader's permissions, its bounds and refusals. A
// member set larger than one answer may cover is refused, never truncated.

import { createHash } from 'node:crypto';
import type { QueryResult, ResultObject, RunOutcome } from '../../contracts/executor/result.contract.ts';
import { getObjectSet, type SetDefinition } from '../../contracts/ontology/objectSet.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { PLAN_SCHEMA_VERSION, queryPlan, type Refusal } from '../../contracts/planner/plan.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';
import { callOptions, type PlanCall } from '../planner/deps.service.ts';
import { activeVersion, manifestOf } from '../planner/manifests.service.ts';
import { runPlan, type ExecutorDeps } from './execute.service.ts';

const PREDICATE_BOUNDS = { steps: 10_000, timeMs: 10 };
const MAX_DEPTH = 5;

type Call = PlanCall & { signal: AbortSignal };

/** A set's members, and what they were drawn from. */
export interface Members {
  objects: ResultObject[];
  /** The sub-results, for the combined result's columns, coverage and lineage. */
  results: QueryResult[];
  /** By object type: how many members each contributed. */
  contributing: Map<string, number>;
  /** An interface set's values are named by its shared properties. */
  columns?: QueryResult['columns'] | undefined;
}

class SetRefused extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.code);
    this.refusal = refusal;
  }
}

/** Values for names a predicate reads besides object and now: an app's parameter variables (spec 35.2). Never in the CEL text. */
export type SetBindings = Readonly<Record<string, string | number | boolean | null | readonly (string | number)[]>>;

export const predicateTest = (cel: string, bindings: SetBindings = {}): ((subject: Record<string, unknown>) => boolean) => {
  const program = compileCel(cel, { object: 'map', now: 'timestamp', ...Object.fromEntries(Object.keys(bindings).map((name) => [name, 'dyn' as const])) });
  const now = new Date();
  return (subject) => {
    try {
      return program.evaluate({ ...bindings, object: subject, now }, PREDICATE_BOUNDS) === true;
    } catch {
      return false;
    }
  };
};

/** Every object of an answer, all its pages. */
async function everyObject(deps: ExecutorDeps, call: Call, result: QueryResult): Promise<ResultObject[]> {
  const out = [...result.page.objects];
  for (let i = 1; i < result.page.count; i += 1) {
    const read = await deps.results.page(call.request, result.queryId, i);
    if (read === undefined) throw new SetRefused({ code: 'query.result_gone', reason: 'a part of the set expired while it was read; run it again' });
    out.push(...read.items as ResultObject[]);
  }
  return out;
}

async function answered(outcome: RunOutcome): Promise<QueryResult> {
  if (outcome.outcome === 'refusal') throw new SetRefused(outcome.refusal);
  return outcome.result;
}

const count = (objects: readonly ResultObject[]) => {
  const out = new Map<string, number>();
  for (const o of objects) out.set(o.objectTypeId, (out.get(o.objectTypeId) ?? 0) + 1);
  return out;
};

/** A plan of the root type (and a path), keeping the root objects a test passes. */
async function runRoot(deps: ExecutorDeps, call: Call, manifest: OntologyManifest, input: {
  nodes: string[]; hops: { linkTypeId: string; routeId: string }[]; select: { node: number; property: string }[];
  keep: { hash: string; properties: string[]; test: (subject: Record<string, unknown>, objectId: string) => boolean };
  trigger: string; useCache: boolean;
}): Promise<QueryResult> {
  const plan = queryPlan.parse({
    schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: manifest.version.id,
    nodes: input.nodes.map((objectTypeId) => ({ objectTypeId })),
    hops: input.hops.map((h, i) => ({ from: i, to: i + 1, linkTypeId: h.linkTypeId, routeId: h.routeId })),
    select: [...new Map([...input.select, ...input.keep.properties.map((property) => ({ node: 0, property }))].map((s) => [`${s.node}:${s.property}`, s])).values()],
  });
  return answered(await runPlan(deps, call, { plan, parameters: {}, trigger: input.trigger, useCache: input.useCache, keep: input.keep }));
}

const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function membersOf(deps: ExecutorDeps, call: Call, manifest: OntologyManifest, definition: SetDefinition, select: readonly string[],
  run: { trigger: string; useCache: boolean }, depth: number, bindings: SetBindings = {}): Promise<Members> {
  if (depth > MAX_DEPTH) {
    throw new SetRefused({ code: 'query.object_set_depth', reason: `sets nest more than ${MAX_DEPTH} deep; refused rather than walked without end` });
  }
  const nested = async (id: string) => {
    const set = await deps.services.call(getObjectSet, { params: { objectSetId: id } }, callOptions(call));
    return membersOf(deps, call, manifest, set.definition, select, run, depth + 1, bindings);
  };

  if (definition.kind === 'filter' && 'objectTypeId' in definition.base) {
    const test = predicateTest(definition.predicate.cel, bindings);
    const result = await runRoot(deps, call, manifest, {
      nodes: [definition.base.objectTypeId], hops: [], select: select.map((property) => ({ node: 0, property })),
      keep: { hash: hashOf(Object.keys(bindings).length === 0 ? definition : { definition, bindings }), properties: [...definition.predicate.properties], test: (subject) => test(subject) }, ...run,
    });
    const objects = await everyObject(deps, call, result);
    return { objects, results: [result], contributing: count(objects) };
  }

  if (definition.kind === 'explicit') {
    const ids = new Set(definition.ids);
    const result = await runRoot(deps, call, manifest, {
      nodes: [definition.objectTypeId], hops: [], select: select.map((property) => ({ node: 0, property })),
      keep: { hash: hashOf(Object.keys(bindings).length === 0 ? definition : { definition, bindings }), properties: [], test: (_s, objectId) => ids.has(objectId) }, ...run,
    });
    const objects = await everyObject(deps, call, result);
    return { objects, results: [result], contributing: count(objects) };
  }

  if (definition.kind === 'filter') {
    // Over an interface: one sub-plan per implementing type the reader may see (21.9).
    const iface = manifest.interfaces.find((i) => i.id === (definition.base as { interfaceId: string }).interfaceId);
    if (iface === undefined) throw new SetRefused({ code: 'query.interface_unavailable', reason: 'the set is over an interface that is not on main' });
    // A marking on the interface the reader does not hold withholds the set whole (spec 21.15), and does not name why.
    const decided = await deps.services.call(resolveAccess, { body: { interfaces: [iface.id] } }, callOptions(call));
    if (!decided.interfaces.some((i) => i.id === iface.id && i.visible)) {
      throw new SetRefused({ code: 'query.interface_unavailable', reason: 'the set is over an interface that is not available to you' });
    }
    const shared = manifest.sharedProperties.filter((s) => iface.requiredSharedPropertyIds.includes(s.id));
    const wanted = select.length === 0 ? shared.map((s) => s.id) : select;
    const test = predicateTest(definition.predicate.cel, bindings);
    const objects: ResultObject[] = [];
    const results: QueryResult[] = [];
    const columns = new Map<string, QueryResult['columns'][number]>();
    for (const type of manifest.objectTypes.filter((t) => t.status !== 'retired' && t.implements.some((i) => i.interfaceId === iface.id))) {
      const bindings = type.implements.find((i) => i.interfaceId === iface.id)!.propertyBindings;
      const props = wanted.map((sharedId) => ({ sharedId, identity: bindings[sharedId] })).filter((p): p is { sharedId: string; identity: string } => p.identity !== undefined);
      const outcome = await runPlan(deps, call, {
        plan: queryPlan.parse({
          schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: manifest.version.id, nodes: [{ objectTypeId: type.id }],
          select: props.map((p) => ({ node: 0, property: p.identity })),
        }),
        parameters: {}, ...run, keep: { hash: hashOf({ definition, type: type.id }), properties: [], test: () => test({}) },
      });
      // A type the reader may not see contributes nothing, and is not named.
      if (outcome.outcome === 'refusal' && ['plan.object_type_unavailable', 'plan.property_unavailable'].includes(outcome.refusal.code)) continue;
      const result = await answered(outcome);
      results.push(result);
      const rename = new Map(props.map((p) => {
        const property = type.properties.find((x) => x.identityId === p.identity)!;
        return [property.apiName, manifest.sharedProperties.find((s) => s.id === p.sharedId)!.apiName] as const;
      }));
      for (const c of result.columns) {
        const sharedName = rename.get(c.apiName);
        const sharedProperty = manifest.sharedProperties.find((s) => s.apiName === sharedName);
        if (sharedProperty === undefined) continue;
        const known = columns.get(sharedProperty.id);
        const rank = { allow: 0, mask: 1, redact: 2 } as const;
        if (known === undefined || rank[c.effect] > rank[known.effect]) {
          columns.set(sharedProperty.id, { ...c, property: sharedProperty.id, apiName: sharedProperty.apiName, displayName: sharedProperty.displayName, dataType: sharedProperty.dataType });
        }
      }
      for (const o of await everyObject(deps, call, result)) {
        const values: ResultObject['values'] = {};
        const states: ResultObject['states'] = {};
        for (const [name, sharedName] of rename) {
          if (name in o.values) values[sharedName] = o.values[name]!;
          if (name in o.states) states[sharedName] = o.states[name]!;
        }
        const named = (list: string[]) => list.flatMap((n) => (rename.has(n) ? [rename.get(n)!] : []));
        objects.push({ ...o, values, states, disputed: named(o.disputed), masked: named(o.masked), redacted: named(o.redacted), links: {} });
      }
    }
    return { objects, results, contributing: count(objects), columns: [...columns.values()] };
  }

  if (definition.kind === 'traversal') {
    // The start, then each hop by its route; the members are the distinct objects at the end.
    let startType: string;
    let keep: { hash: string; properties: string[]; test: (subject: Record<string, unknown>, objectId: string) => boolean };
    if ('objectSetId' in definition.start) {
      const start = await nested(definition.start.objectSetId);
      const ids = new Set(start.objects.map((o) => o.id));
      const types = [...start.contributing.keys()];
      if (types.length > 1) throw new SetRefused({ code: 'query.object_set_unsupported', reason: 'a traversal starts from a set of one object type' });
      startType = types[0] ?? '';
      if (startType === '') return { objects: [], results: start.results, contributing: new Map() };
      keep = { hash: hashOf(Object.keys(bindings).length === 0 ? definition : { definition, bindings }), properties: [], test: (_s, id) => ids.has(id) };
    } else {
      const predicate = definition.start.predicate;
      const test = predicate === undefined ? () => true : predicateTest(predicate.cel, bindings);
      startType = definition.start.objectTypeId;
      keep = { hash: hashOf(Object.keys(bindings).length === 0 ? definition : { definition, bindings }), properties: [...(predicate?.properties ?? [])], test: (subject) => test(subject) };
    }
    const nodes = [startType];
    const hops: { linkTypeId: string; routeId: string }[] = [];
    for (const step of definition.path) {
      const link = manifest.linkTypes.find((l) => l.id === step.linkTypeId);
      if (link === undefined) throw new SetRefused({ code: 'plan.link_type_unavailable', reason: 'the set walks a link type that is not on main', element: { kind: 'link_type', id: step.linkTypeId } });
      const routeId = step.routeId ?? link.defaultRouteId ?? (link.routes.length === 1 ? link.routes[0]!.id : undefined);
      if (routeId === undefined) {
        throw new SetRefused({ code: 'query.route_needed', reason: `${link.apiName} has several routes and no default: the set must say which it walks`, element: { kind: 'link_type', id: link.id, name: link.apiName } });
      }
      nodes.push(step.direction === 'forward' ? link.toTypeId : link.fromTypeId);
      hops.push({ linkTypeId: link.id, routeId });
    }
    const last = nodes.length - 1;
    // The members are the end type's objects: what they show is read there, its title when nothing is asked for.
    const title = manifest.objectTypes.find((t) => t.id === nodes[last])?.titlePropertyIdentityId;
    const shown = select.length > 0 ? select : title === undefined ? [] : [title];
    const result = await runRoot(deps, call, manifest, { nodes, hops, select: shown.map((property) => ({ node: last, property })), keep, ...run });
    const leaves = new Map<string, ResultObject>();
    const walk = (o: ResultObject, hop: number) => {
      if (hop === hops.length) { if (!leaves.has(o.id)) leaves.set(o.id, { ...o, links: {} }); return; }
      for (const next of o.links[String(hop)] ?? []) walk(next, hop + 1);
    };
    for (const root of await everyObject(deps, call, result)) walk(root, 0);
    const objects = [...leaves.values()];
    return { objects, results: [result], contributing: count(objects) };
  }

  // A set operation over saved sets of one type or interface, by Silo object id.
  const operands = [];
  for (const id of definition.operands) operands.push(await nested(id));
  const [first, ...rest] = operands;
  const idsOf = (m: Members) => new Set(m.objects.map((o) => o.id));
  const restIds = rest.map(idsOf);
  const pool = new Map<string, ResultObject>();
  for (const m of operands) for (const o of m.objects) if (!pool.has(o.id)) pool.set(o.id, o);
  const kept = definition.operation === 'union' ? [...pool.values()]
    : definition.operation === 'intersection' ? first!.objects.filter((o) => restIds.every((ids) => ids.has(o.id)))
      : first!.objects.filter((o) => restIds.every((ids) => !ids.has(o.id)));
  return { objects: kept, results: operands.flatMap((m) => m.results), contributing: count(kept), columns: first!.columns };
}

/** Runs a set the engine walks itself, as one answer. */
export async function runWalkedSet(deps: ExecutorDeps, call: Call, definition: SetDefinition, input: {
  setId: string; select: readonly string[]; trigger: string; useCache: boolean; bindings?: SetBindings | undefined;
}): Promise<RunOutcome> {
  try {
    const version = await activeVersion(deps, call);
    const manifest = await manifestOf(deps, call, version.id);
    const members = await membersOf(deps, call, manifest, definition, input.select, { trigger: input.trigger, useCache: input.useCache }, 0, input.bindings ?? {});
    const bound = deps.bounds.maxResultRows;
    if (members.objects.length > bound) {
      return { outcome: 'refusal', refusal: {
        code: 'query.bound_merged_result', reason: `the set has ${members.objects.length} members, more than one answer may cover (${bound}); refused, never truncated`,
        bound: { name: 'merged_result', limit: bound, observed: members.objects.length }, element: { kind: 'plan', id: input.setId },
      } };
    }
    const base = members.results[0];
    const sum = (pick: (r: QueryResult) => Record<string, number>) => {
      const out: Record<string, number> = {};
      for (const r of members.results) for (const [k, v] of Object.entries(pick(r))) out[k] = (out[k] ?? 0) + v;
      return out;
    };
    const result = await deps.results.keep(call.request, {
      queryId: uuidv7(), planHash: hashOf({ setId: input.setId, definition, select: input.select, ...(input.bindings === undefined || Object.keys(input.bindings).length === 0 ? {} : { bindings: input.bindings }) }), ontologyVersionId: manifest.version.id, kind: 'objects',
      columns: members.columns ?? base?.columns ?? [], measures: [], population: members.objects.length, total: members.objects.length,
      coverage: {
        objects: members.objects.length, unmatched: members.objects.filter((o) => o.unmatched).length,
        disputed: sum((r) => r.coverage.disputed), empty: sum((r) => r.coverage.empty), unchecked: sum((r) => r.coverage.unchecked),
        excludedByDispute: members.results.reduce((t, r) => t + r.coverage.excludedByDispute, 0),
      },
      lineage: members.results.flatMap((r) => r.lineage), periods: [], localFilters: members.results.flatMap((r) => r.localFilters),
      reduced: members.results.some((r) => r.reduced), aggregateForm: null, defaults: { timeFields: [], routes: [] },
      contributingTypes: [...members.contributing.entries()].map(([objectTypeId, objects]) => ({ objectTypeId, objects })),
      computedAt: new Date().toISOString(),
    }, members.objects, undefined);
    return { outcome: 'answer', result };
  } catch (error) {
    if (error instanceof SetRefused) return { outcome: 'refusal', refusal: error.refusal };
    throw error;
  }
}
