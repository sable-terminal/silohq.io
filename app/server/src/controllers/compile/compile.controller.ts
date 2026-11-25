// compile's endpoints. A keyed compile keeps its whole outcome in the data plane, so a
// retry under the same key replays it without a second model call or charge.

import type {
  compileFailure, compilePlan, compileQuestion, copyPlanBinding, getCompiledPlan, getVocabulary, runCompiledPlan,
} from '../../contracts/compile/compile.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import {
  compiledPlan, compileFailureStatement, compileQuestion as compile, compileStructured, copyBinding, keepOutcome, replayOutcome, runCompiled, vocabularyOf, type CompileDeps,
} from '../../services/compile/compile.service.ts';

export function compileController(deps: CompileDeps): {
  compileQuestion: RouteHandlers<typeof compileQuestion>;
  compilePlan: RouteHandlers<typeof compilePlan>;
  getCompiledPlan: RouteHandlers<typeof getCompiledPlan>;
  getVocabulary: RouteHandlers<typeof getVocabulary>;
  runCompiledPlan: RouteHandlers<typeof runCompiledPlan>;
  copyPlanBinding: RouteHandlers<typeof copyPlanBinding>;
  compileFailure: RouteHandlers<typeof compileFailure>;
} {
  // The outcome's reference, kept when the outcome is: handle writes it, resultRef reads it.
  const refs = new WeakMap<object, string>();
  return {
    compileQuestion: {
      async handle({ body }, ctx) {
        const outcome = await compile(deps, ctx, body);
        refs.set(outcome, await keepOutcome(deps, ctx, outcome));
        return outcome;
      },
      resultRef: (outcome) => refs.get(outcome as object) ?? '',
      replay: (ref, ctx) => replayOutcome(deps, ctx, ref),
    },
    compilePlan: { handle: ({ body }, ctx) => compileStructured(deps, ctx, body) },
    getCompiledPlan: { handle: ({ params }, ctx) => compiledPlan(deps, ctx, params.planId) },
    getVocabulary: { handle: ({ query }, ctx) => vocabularyOf(deps, ctx, query.ontologyVersionId, query.branchId) },
    runCompiledPlan: { handle: ({ params, body }, ctx) => runCompiled(deps, ctx, params.planId, body) },
    copyPlanBinding: { handle: ({ params, body }, ctx) => copyBinding(deps, ctx, params.bindingId, body.toBindingId) },
    compileFailure: {
      async handle({ body }, ctx) {
        const outcome = await compileFailureStatement(deps, ctx, body);
        refs.set(outcome, await keepOutcome(deps, ctx, outcome as never));
        return outcome;
      },
      resultRef: (outcome) => refs.get(outcome as object) ?? '',
      replay: async (ref, ctx) => (await replayOutcome(deps, ctx, ref)) as never,
    },
  };
}
