// Resources and capacity (decision 2026-11-14; D86), as capacity requirements planning has
// it: a resource is an object with a capacity (units per period); a resource edge carries how
// much of it one unit of a dependant consumes. A stated failure on resources leaves them a
// share of their capacity (reduced capacity states it; unavailable leaves none). For each
// such resource, demand is the sum over its linked dependants of consumption times their
// units in the period; where demand exceeds the capacity left, every dependant of it is
// flagged with the share of demand that cannot be met. Flagged dependants are reported, not
// walked further: what a shortfall does downstream depends on how the business rations it.
// Values are read through the executor under the runner's access and held only for the run.

import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { readResultPage, runPlan, type ResultObject } from '../../contracts/executor/result.contract.ts';
import type { DependencyEdge } from '../../models/simulation/dependencyEdge.model.ts';
import { AppError } from '../../utils/errors.util.ts';
import type { Context, SimulationDeps } from './deps.service.ts';

export interface ResourceDemand { resourceId: string; capacity: number | null; dependants: { id: string; units: number | null }[] }
export interface Constrained { resourceId: string; dependantId: string; shortfall: number }

const asNumber = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** The dependants left short (pure): demand over the capacity left, by resource. */
export function shortfalls(resources: readonly ResourceDemand[], consumption: number, remaining: number): Constrained[] {
  const out: Constrained[] = [];
  for (const r of resources) {
    if (r.capacity === null) continue;
    const demand = r.dependants.reduce((sum, d) => sum + consumption * Math.max(d.units ?? 0, 0), 0);
    const left = Math.max(r.capacity, 0) * remaining;
    if (demand <= 0 || demand <= left) continue;
    const shortfall = Math.round((1 - left / demand) * 10_000) / 10_000;
    for (const d of r.dependants) if ((d.units ?? 0) > 0) out.push({ resourceId: r.resourceId, dependantId: d.id, shortfall });
  }
  return out;
}

/** Each named resource's capacity and its dependants' units, along one resource edge. */
export async function readDemand(deps: SimulationDeps, ctx: Context, manifest: OntologyManifest, edge: DependencyEdge, resourceIds: ReadonlySet<string>)
  : Promise<ResourceDemand[] | 'bounded'> {
  const link = manifest.linkTypes.find((l) => l.id === edge.viaLinkTypeId);
  const routeId = link?.defaultRouteId ?? link?.routes[0]?.id;
  const from = manifest.objectTypes.find((t) => t.id === edge.fromObjectTypeId);
  const to = manifest.objectTypes.find((t) => t.id === edge.toObjectTypeId);
  const capacityName = from?.properties.find((p) => p.identityId === edge.capacityPropertyId)?.apiName;
  const demandName = to?.properties.find((p) => p.identityId === edge.demandPropertyId)?.apiName;
  if (link === undefined || routeId === undefined || capacityName === undefined || demandName === undefined) return [];
  const call = { request: ctx.request, correlationId: ctx.correlationId };
  const out = await deps.services.call(runPlan, {
    body: {
      plan: {
        schemaVersion: '1', ontologyVersionId: manifest.version.id,
        nodes: [{ objectTypeId: edge.fromObjectTypeId, filters: [] }, { objectTypeId: edge.toObjectTypeId, filters: [] }],
        hops: [{ from: 0, to: 1, linkTypeId: link.id, routeId }],
        select: [{ node: 0, property: edge.capacityPropertyId! }, { node: 1, property: edge.demandPropertyId! }], sort: [],
      },
      parameters: {}, trigger: 'structured', useCache: false,
    },
  }, call);
  if (out.outcome === 'refusal') {
    if (out.refusal.code.startsWith('query.bound_')) return 'bounded';
    throw new AppError('unavailable', 'a system the capacity check needs is not answering, so no result is given as if complete', {
      code: 'simulation.source_unavailable', details: { refusal: out.refusal.code },
    });
  }
  const objects: ResultObject[] = [...out.result.page.objects];
  for (let index = 1; index < out.result.page.count; index += 1) {
    objects.push(...(await deps.services.call(readResultPage, { params: { queryId: out.result.queryId, page: index } }, call)).objects);
  }
  return objects.filter((o) => resourceIds.has(o.id)).map((o) => ({
    resourceId: o.id, capacity: asNumber(o.values[capacityName]),
    dependants: (o.links['0'] ?? o.links[0] ?? []).map((d) => ({ id: d.id, units: asNumber(d.values[demandName]) })),
  }));
}
