// A plan over an interface (spec 21.9): its root names an interface, not an object type, and
// it is expanded to one sub-plan per implementing type the reader may see. Its filters, period,
// selections, groups, measures and sorts name the interface's required shared properties; in
// each sub-plan they name the property the type binds to that shared property. An interface
// carries no data and no resolution: objects keep their own type, and two objects of different
// types are never one. A marking on the interface the reader does not hold withholds the plan
// whole, without saying why (21.15). Planner and executor both expand through here.

import type { InterfaceView, OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import type { PlanExplanation, PlanNode, PlanParameters, QueryPlan, Refusal } from '../../contracts/planner/plan.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { isRefusal } from './access.service.ts';
import { buildProgram, explanationOf } from './decompose.service.ts';
import { callOptions, type PlanCall, type PlannerDeps } from './deps.service.ts';
import { manifestOf } from './manifests.service.ts';

export interface InterfaceSubPlan {
  objectTypeId: string;
  plan: QueryPlan;
  /** The type's property API names to the interface's shared property API names. */
  names: Map<string, string>;
}

export interface ExpandedPlan {
  iface: InterfaceView;
  manifest: OntologyManifest;
  /** The interface's shared properties the plan names, by id. */
  shared: Map<string, OntologyManifest['sharedProperties'][number]>;
  types: InterfaceSubPlan[];
}

const refuse = (code: string, reason: string, extra: Partial<Refusal> = {}): Refusal => ({ code, reason, ...extra });

export const isInterfacePlan = (plan: QueryPlan): boolean => plan.nodes[0]?.interfaceId !== undefined;

/** The shared property ids a plan over an interface names. */
function namedProperties(plan: QueryPlan): string[] {
  const root = plan.nodes[0]!;
  return [...new Set([
    ...root.filters.map((f) => f.property), ...(root.period === undefined ? [] : [root.period.property]),
    ...plan.select.map((s) => s.property), ...(plan.aggregate?.groupBy.map((g) => g.property) ?? []),
    ...(plan.aggregate?.measures.flatMap((m) => (m.property === undefined ? [] : [m.property])) ?? []),
    ...plan.sort.flatMap((s) => (s.property === undefined ? [] : [s.property])),
  ])];
}

export async function expandInterfacePlan(deps: PlannerDeps, call: PlanCall, plan: QueryPlan): Promise<ExpandedPlan | Refusal> {
  const root = plan.nodes[0]!;
  const manifest = await manifestOf(deps, call, plan.ontologyVersionId);
  const iface = manifest.interfaces.find((i) => i.id === root.interfaceId);
  const unavailable = refuse('plan.interface_unavailable', 'the plan is over an interface that is not available to you', {
    element: { kind: 'interface', id: root.interfaceId! },
  });
  if (iface === undefined) return unavailable;
  const decided = await deps.services.call(resolveAccess, {
    body: { interfaces: [iface.id], ...(call.purposeSessionIds === undefined ? {} : { purposeSessionIds: [...call.purposeSessionIds] }) },
  }, callOptions(call));
  if (decided.decision !== 'allow' || !decided.interfaces.some((i) => i.id === iface.id && i.visible)) return unavailable;

  const shared = new Map<string, OntologyManifest['sharedProperties'][number]>();
  for (const id of namedProperties(plan)) {
    const property = iface.requiredSharedPropertyIds.includes(id) ? manifest.sharedProperties.find((s) => s.id === id) : undefined;
    if (property === undefined) {
      return refuse('plan.property_unavailable', `${iface.apiName} requires no shared property by that id`, { element: { kind: 'property', id } });
    }
    shared.set(id, property);
  }

  const types: InterfaceSubPlan[] = [];
  for (const type of manifest.objectTypes) {
    const implementation = type.status === 'retired' ? undefined : type.implements.find((i) => i.interfaceId === iface.id);
    if (implementation === undefined) continue;
    const bound = (sharedId: string): string | undefined => implementation.propertyBindings[sharedId];
    if ([...shared.keys()].some((id) => bound(id) === undefined)) continue;
    const node: PlanNode = {
      objectTypeId: type.id,
      filters: root.filters.map((f) => ({ ...f, property: bound(f.property)! })),
      ...(root.period === undefined ? {} : { period: { ...root.period, property: bound(root.period.property)! } }),
    };
    const typePlan: QueryPlan = {
      ...plan,
      nodes: [node],
      select: plan.select.map((s) => ({ node: 0, property: bound(s.property)! })),
      ...(plan.aggregate === undefined ? {} : {
        aggregate: {
          groupBy: plan.aggregate.groupBy.map((g) => ({ node: 0, property: bound(g.property)!, ...(g.bucket !== undefined ? { bucket: g.bucket } : {}) })),
          measures: plan.aggregate.measures.map((m) => ({ ...m, ...(m.property === undefined ? {} : { property: bound(m.property)! }) })),
        },
      }),
      sort: plan.sort.map((s) => (s.property === undefined ? s : { ...s, property: bound(s.property)! })),
    };
    const names = new Map<string, string>();
    for (const [sharedId, identityId] of Object.entries(implementation.propertyBindings)) {
      const property = type.properties.find((p) => p.identityId === identityId);
      const sharedProperty = manifest.sharedProperties.find((s) => s.id === sharedId);
      if (property !== undefined && sharedProperty !== undefined) names.set(property.apiName, sharedProperty.apiName);
    }
    types.push({ objectTypeId: type.id, plan: typePlan, names });
  }
  return { iface, manifest, shared, types };
}

/** Refusals meaning the reader may not see a type: it contributes nothing, and is not named. */
export const UNSEEN_TYPE = new Set(['plan.object_type_unavailable', 'plan.property_unavailable']);

/** The bounds stage for a plan over an interface: each implementing type's program, one node each. */
export async function explainInterfacePlan(deps: PlannerDeps, call: PlanCall, plan: QueryPlan, parameters: PlanParameters): Promise<PlanExplanation | Refusal> {
  const expanded = await expandInterfacePlan(deps, call, plan);
  if (isRefusal(expanded)) return expanded;
  const explained: PlanExplanation[] = [];
  const typeIds: string[] = [];
  for (const t of expanded.types) {
    const program = await buildProgram(deps, call, t.plan, parameters);
    if (isRefusal(program)) {
      if (UNSEEN_TYPE.has(program.code)) continue;
      return program;
    }
    explained.push(explanationOf(program));
    typeIds.push(t.objectTypeId);
  }
  const first = explained[0];
  return {
    nodes: explained.flatMap((e) => e.nodes), hops: [],
    bounds: first?.bounds ?? { rowsPerSource: deps.bounds.maxRowsPerSourceStep, keysPerHop: deps.bounds.fanOutPerHop, mergedResult: deps.bounds.maxResultRows, wallTimeMs: deps.bounds.wallTimeMs },
    periods: explained.flatMap((e) => e.periods),
    interface: { interfaceId: expanded.iface.id, objectTypeIds: typeIds },
  };
}
