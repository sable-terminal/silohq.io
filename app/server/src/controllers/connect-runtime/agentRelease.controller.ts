// connect-runtime's agent release endpoint: a release of the cell's agent channel, carried in
// by the cell's Fleet agent and checked again here (spec 10.7, 11.4;
// contracts/connect-runtime/agentRelease.contract.ts).

import type { installAgentRelease } from '../../contracts/connect-runtime/agentRelease.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { AgentUpdates } from '../../services/connect-runtime/agentUpdates.service.ts';
import { AppError } from '../../utils/errors.util.ts';

export function agentReleaseController(updates: AgentUpdates | undefined): RouteHandlers<typeof installAgentRelease> {
  return {
    async handle({ body }) {
      if (updates === undefined) {
        throw new AppError('configuration', 'this cell has no Silo release key or object storage for agent releases', { code: 'agent.updates_unavailable' });
      }
      return updates.install(body);
    },
  };
}
