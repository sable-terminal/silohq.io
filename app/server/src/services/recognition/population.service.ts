// A detector's population (spec 38.2): every object of a type, with the properties the run
// examines, read once through the executor under the runner's own access (spec 27). The
// executor refuses rather than truncates, so a population is whole or not read: a bound
// becomes the `bounded` run state, a system not answering `source_unreachable`.

import { readResultPage, runPlan, type QueryResult, type ResultObject } from '../../contracts/executor/result.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import type { Refusal } from '../../contracts/planner/plan.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import type { Context, RecognitionDeps } from './deps.service.ts';
import type { PopulationObject } from './detectors.service.ts';

export type PopulationRead =
  | { kind: 'read'; objects: PopulationObject[]; coverage: QueryResult['coverage'] }
  | { kind: 'bounded'; detail: Record<string, string | number> }
  | { kind: 'source_unreachable'; detail: Record<string, string | number> };

export async function readPopulation(deps: RecognitionDeps, ctx: Context, manifest: OntologyManifest, objectTypeId: string,
  propertyIdentityIds: readonly string[]): Promise<PopulationRead> {
  const call = { request: ctx.request, correlationId: ctx.correlationId };
  const out = await deps.services.call(runPlan, {
    body: {
      plan: {
        schemaVersion: '1', ontologyVersionId: manifest.version.id, nodes: [{ objectTypeId, filters: [] }], hops: [],
        select: propertyIdentityIds.map((property) => ({ node: 0, property })), sort: [],
      },
      parameters: {}, trigger: 'structured', useCache: false,
    },
  }, call);
  if (out.outcome === 'refusal') return refused(out.refusal);
  const result = out.result;
  const objects: ResultObject[] = [...result.page.objects];
  for (let index = 1; index < result.page.count; index += 1) {
    const page = await deps.services.call(readResultPage, { params: { queryId: result.queryId, page: index } }, call);
    objects.push(...page.objects);
  }
  return {
    kind: 'read',
    objects: objects.map((o) => ({ id: o.id, values: o.values, disputed: o.disputed, unmatched: o.unmatched })),
    coverage: result.coverage,
  };
}

function refused(refusal: Refusal): PopulationRead {
  if (refusal.code === 'query.source_unavailable') {
    const connectionId = refusal.element?.kind === 'connection' ? refusal.element.id : refusal.bound?.connectionId;
    return { kind: 'source_unreachable', detail: connectionId === undefined ? {} : { connectionId } };
  }
  if (refusal.code.startsWith('query.bound_') && refusal.bound !== undefined) {
    return {
      kind: 'bounded',
      detail: {
        bound: refusal.bound.name, limit: refusal.bound.limit,
        ...(refusal.bound.observed === undefined ? {} : { observed: refusal.bound.observed }),
        ...(refusal.bound.connectionId === undefined ? {} : { connectionId: refusal.bound.connectionId }),
      },
    };
  }
  throw new AppError('conflict', 'the population could not be read', { code: 'recognition.population_refused', details: { refusal: refusal.code } });
}
