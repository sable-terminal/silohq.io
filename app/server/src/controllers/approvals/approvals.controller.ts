// approvals' endpoints: parsed input to the approvals service and back.

import type {
  createApprovalPolicy, decideApproval, getChain, listApprovalInbox, listApprovalPolicies, requestApproval, setPolicyFloor, supersedeApprovalPolicy,
} from '../../contracts/approvals/approval.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { Chains } from '../../services/approvals/chains.service.ts';
import type { Policies } from '../../services/approvals/policies.service.ts';

export function approvalsController(chains: Chains, policies: Policies) {
  return {
    request: { handle: ({ body }, ctx) => chains.request(ctx, body.mutationId) } satisfies RouteHandlers<typeof requestApproval>,
    get: { handle: ({ params }, ctx) => chains.get(ctx, params.chainId) } satisfies RouteHandlers<typeof getChain>,
    inbox: { handle: async ({ query }, ctx) => ({ chains: await chains.inbox(ctx, query.limit, query.forMe === 'true') }) } satisfies RouteHandlers<typeof listApprovalInbox>,
    decide: { handle: ({ params, body }, ctx) => chains.decide(ctx, params.chainId, body) } satisfies RouteHandlers<typeof decideApproval>,
    createPolicy: { handle: ({ body }, ctx) => policies.create(ctx, body) } satisfies RouteHandlers<typeof createApprovalPolicy>,
    supersedePolicy: { handle: ({ params, body }, ctx) => policies.supersede(ctx, params.policyId, body) } satisfies RouteHandlers<typeof supersedeApprovalPolicy>,
    listPolicies: {
      handle: async ({ query }, ctx) => ({ policies: await policies.list(ctx, query.connectionId, query.includeSuperseded === 'true') }),
    } satisfies RouteHandlers<typeof listApprovalPolicies>,
    setFloor: { handle: ({ body }, ctx) => policies.setFloor(ctx, body) } satisfies RouteHandlers<typeof setPolicyFloor>,
  };
}
