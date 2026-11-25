// executor (spec 27): runs validated plans against the sources where they sit, merges by
// identity, and returns one bounded result object with lineage on every figure, or refuses.
// The planner's modules run in this process.

import { resolveActionTargets } from '../../contracts/executor/actionTargets.contract.ts';
import { readObjectView } from '../../contracts/executor/objectView.contract.ts';
import { readResult, readResultPage, runObjectSet, runPlan } from '../../contracts/executor/result.contract.ts';
import { runController } from '../../controllers/executor/run.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { createResults } from '../../services/executor/results.service.ts';

export const service = defineService({
  name: 'executor',
  // control: the calendar and the outbox (query events); data: result pages, the result
  // cache and the concurrency leases.
  needs: { postgres: ['control'], redis: ['data'] },
  create(deps) {
    const c = runController({
      databases: deps.databases, services: deps.services, bounds: deps.config.executorBounds, logger: deps.logger,
      results: createResults(deps.redis.data!),
      // Capture's queue lives in redis-data too (spec 67.2).
      capture: { databases: deps.databases, redis: deps.redis.data, logger: deps.logger },
    });
    return { routes: [route(runPlan, c.runPlan), route(runObjectSet, c.runObjectSet), route(readResultPage, c.readResultPage), route(readResult, c.readResult), route(readObjectView, c.readObjectView), route(resolveActionTargets, c.resolveActionTargets)] };
  },
});
