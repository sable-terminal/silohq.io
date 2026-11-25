// What the planner needs, whether it runs as its own service (explainPlan) or inside the
// executor's process (the catalogue: planner starts inside executor; the names stay
// separate so it can move without an interface changing).

import type { ExecutorBounds } from '../../config/limits.config.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases, RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';

export interface PlannerDeps {
  databases: Databases;
  /** Calls ontology, policy and pushdown-compiler as the hosting service. */
  services: ServiceClient;
  bounds: ExecutorBounds;
  logger: Logger;
}

/** The request a plan is decomposed for: who asks, under which correlation, until when. */
export interface PlanCall {
  request: RequestContext;
  correlationId: string;
  signal?: AbortSignal | undefined;
  purposeSessionIds?: readonly string[] | undefined;
}

export const callOptions = (call: PlanCall) => ({
  request: call.request, correlationId: call.correlationId, ...(call.signal === undefined ? {} : { signal: call.signal }),
});
