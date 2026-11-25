// The executor's endpoints: run a plan (an answer or a refusal), and read a further page of
// a result while it lives in the data plane.

import type { resolveActionTargets } from '../../contracts/executor/actionTargets.contract.ts';
import type { readObjectView } from '../../contracts/executor/objectView.contract.ts';
import type { readResult, readResultPage, runObjectSet, runPlan } from '../../contracts/executor/result.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { resolveActionTargets as targetsOf } from '../../services/executor/actionTargets.service.ts';
import { readPage, readResult as readWhole, runPlan as run, type ExecutorDeps } from '../../services/executor/execute.service.ts';
import { runObjectSet as runSet } from '../../services/executor/objectSet.service.ts';
import { readObjectView as readView } from '../../services/executor/objectView.service.ts';

export function runController(deps: ExecutorDeps): {
  runPlan: RouteHandlers<typeof runPlan>;
  readResultPage: RouteHandlers<typeof readResultPage>;
  readResult: RouteHandlers<typeof readResult>;
  runObjectSet: RouteHandlers<typeof runObjectSet>;
  readObjectView: RouteHandlers<typeof readObjectView>;
  resolveActionTargets: RouteHandlers<typeof resolveActionTargets>;
} {
  return {
    resolveActionTargets: {
      handle: ({ body }, ctx) => targetsOf(deps, { request: ctx.request, correlationId: ctx.correlationId, signal: ctx.signal }, body),
    },
    runPlan: {
      handle: ({ body }, ctx) => run(deps, {
        request: ctx.request, correlationId: ctx.correlationId, signal: ctx.signal, purposeSessionIds: body.purposeSessionIds,
      }, { plan: body.plan, parameters: body.parameters, planId: body.planId, trigger: body.trigger, useCache: body.useCache, references: body.references }),
    },
    runObjectSet: {
      handle: ({ body }, ctx) => runSet(deps, {
        request: ctx.request, correlationId: ctx.correlationId, signal: ctx.signal, purposeSessionIds: body.purposeSessionIds,
      }, { objectSetId: body.objectSetId, definition: body.definition, bindings: body.bindings, select: body.select, trigger: body.trigger, useCache: body.useCache }),
    },
    readObjectView: {
      handle: ({ body }, ctx) => readView(deps, {
        request: ctx.request, correlationId: ctx.correlationId, signal: ctx.signal, purposeSessionIds: body.purposeSessionIds,
      }, { objectTypeId: body.objectTypeId, object: body.object }),
    },
    readResult: {
      handle: ({ params }, ctx) => readWhole(deps, { request: ctx.request, correlationId: ctx.correlationId }, params.queryId),
    },
    readResultPage: {
      handle: ({ params }, ctx) => readPage(deps, { request: ctx.request, correlationId: ctx.correlationId }, params.queryId, params.page),
    },
  };
}
