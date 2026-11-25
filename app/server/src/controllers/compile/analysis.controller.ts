// compile's analysis endpoints (spec 37.8): a chain kept as an analysis manifest, run step by step,
// and read back with its values for the person who bound them.

import type { analysisFromPlan, compileAnalysis, getAnalysis, runAnalysis } from '../../contracts/compile/analysis.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { analysisFromPlan as fromPlan, analysisOf, compileChain, runChain } from '../../services/compile/analysis.service.ts';
import type { CompileDeps } from '../../services/compile/compile.service.ts';

export function analysisController(deps: CompileDeps): {
  compileAnalysis: RouteHandlers<typeof compileAnalysis>;
  runAnalysis: RouteHandlers<typeof runAnalysis>;
  getAnalysis: RouteHandlers<typeof getAnalysis>;
  analysisFromPlan: RouteHandlers<typeof analysisFromPlan>;
} {
  return {
    compileAnalysis: { handle: ({ body }, ctx) => compileChain(deps, ctx, body) },
    runAnalysis: { handle: ({ params, body }, ctx) => runChain(deps, ctx, params.manifestId, body) },
    getAnalysis: { handle: ({ params, query }, ctx) => analysisOf(deps, ctx, params.manifestId, query.bindingId) },
    analysisFromPlan: { handle: ({ body }, ctx) => fromPlan(deps, ctx, body) },
  };
}
