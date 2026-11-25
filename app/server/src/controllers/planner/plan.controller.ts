// The planner's endpoint: the bounds stage (spec 26.10). Decomposes, checks and states the
// bounds; reads nothing from any source.

import type { explainPlan } from '../../contracts/planner/plan.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { isRefusal } from '../../services/planner/access.service.ts';
import { buildProgram, explanationOf } from '../../services/planner/decompose.service.ts';
import { explainInterfacePlan, isInterfacePlan } from '../../services/planner/interfacePlans.service.ts';
import type { PlannerDeps } from '../../services/planner/deps.service.ts';

export function planController(deps: PlannerDeps): { explainPlan: RouteHandlers<typeof explainPlan> } {
  return {
    explainPlan: {
      async handle({ body }, ctx) {
        const call = { request: ctx.request, correlationId: ctx.correlationId, signal: ctx.signal, purposeSessionIds: body.purposeSessionIds };
        // Over an interface: each implementing type's program (21.9).
        if (isInterfacePlan(body.plan)) {
          const explained = await explainInterfacePlan(deps, call, body.plan, body.parameters);
          return isRefusal(explained) ? { outcome: 'refusal' as const, refusal: explained } : { outcome: 'plan' as const, explanation: explained };
        }
        const program = await buildProgram(deps, call, body.plan, body.parameters);
        if (isRefusal(program)) return { outcome: 'refusal' as const, refusal: program };
        return { outcome: 'plan' as const, explanation: explanationOf(program) };
      },
    },
  };
}
