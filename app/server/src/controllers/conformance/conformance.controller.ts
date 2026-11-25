// conformance's endpoints: parsed input to the conformance service and back.

import type { getConformanceRun, listConformanceRuns, startConformanceRun } from '../../contracts/conformance/conformance.contract.ts';
import type { startChangeStreamClass } from '../../contracts/conformance/changeStreamClass.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { Conformance } from '../../services/conformance/conformance.service.ts';

export function conformanceController(conformance: Conformance) {
  return {
    start: {
      handle: ({ body }, ctx) => conformance.start(ctx, body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => conformance.get(ctx, ref!),
    } satisfies RouteHandlers<typeof startConformanceRun>,
    streamClass: {
      handle: ({ params, body }, ctx) => conformance.startStreamClass(ctx, params.connectionId, body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => conformance.get(ctx, ref!),
    } satisfies RouteHandlers<typeof startChangeStreamClass>,
    get: {
      handle: ({ params }, ctx) => conformance.get(ctx, params.runId),
    } satisfies RouteHandlers<typeof getConformanceRun>,
    list: {
      handle: async ({ params, query }, ctx) => ({ runs: await conformance.list(ctx, params.connectionId, query.limit) }),
    } satisfies RouteHandlers<typeof listConformanceRuns>,
  };
}
