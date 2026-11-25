// connect-registry: Silo Agent pools and enrolment tokens (contracts/connect-registry/agent.contract.ts).

import type {
  approveAgentPoolUpdate, createAgentPool, issueAgentEnrolmentToken, listAgentPools, listAgentReleases, revokeAgent, setAgentPoolUpdatePolicy,
} from '../../contracts/connect-registry/agent.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as agents from '../../services/connect-registry/agents.service.ts';

export function agentController(deps: agents.AgentDeps) {
  return {
    createAgentPool: { handle: ({ body }, ctx) => agents.createAgentPool(deps, ctx, body) } satisfies RouteHandlers<typeof createAgentPool>,
    listAgentPools: { handle: (_input, ctx) => agents.listAgentPools(deps, ctx) } satisfies RouteHandlers<typeof listAgentPools>,
    issueAgentEnrolmentToken: {
      handle: ({ params }, ctx) => agents.issueAgentEnrolmentToken(deps, ctx, params.poolId),
    } satisfies RouteHandlers<typeof issueAgentEnrolmentToken>,
    revokeAgent: { handle: ({ params }, ctx) => agents.revokeAgent(deps, ctx, params.agentId) } satisfies RouteHandlers<typeof revokeAgent>,
    setAgentPoolUpdatePolicy: {
      handle: ({ params, body }, ctx) => agents.setAgentPoolUpdatePolicy(deps, ctx, params.poolId, body),
    } satisfies RouteHandlers<typeof setAgentPoolUpdatePolicy>,
    approveAgentPoolUpdate: {
      handle: ({ params, body }, ctx) => agents.approveAgentPoolUpdate(deps, ctx, params.poolId, body.version),
    } satisfies RouteHandlers<typeof approveAgentPoolUpdate>,
    listAgentReleases: { handle: (_input, ctx) => agents.listAgentReleases(deps, ctx) } satisfies RouteHandlers<typeof listAgentReleases>,
  };
}
