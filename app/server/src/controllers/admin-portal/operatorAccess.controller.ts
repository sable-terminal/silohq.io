// The customer's side of break-glass, forwarded by the gateway: thin, over
// services/admin-portal/breakGlass. The gateway has decided the route's permission; the
// member comes from the request context.

import type * as c from '../../contracts/admin-portal/operatorAccess.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { BreakGlass } from '../../services/admin-portal/breakGlass.service.ts';

export interface OperatorAccessHandlers {
  list: RouteHandlers<typeof c.listOperatorAccessSessions>;
  get: RouteHandlers<typeof c.getOperatorAccessSession>;
  decide: RouteHandlers<typeof c.decideOperatorAccessSession>;
  revoke: RouteHandlers<typeof c.revokeOperatorAccessSession>;
  policy: RouteHandlers<typeof c.getOperatorAccessPolicy>;
  setPolicy: RouteHandlers<typeof c.setOperatorAccessPolicy>;
}

export function operatorAccessController(breakGlass: BreakGlass): OperatorAccessHandlers {
  return {
    list: { handle: (input, ctx) => breakGlass.customerList(ctx.request, input.query) },
    get: { handle: (input, ctx) => breakGlass.customerGet(ctx.request, input.params.sessionId) },
    decide: { handle: (input, ctx) => breakGlass.customerDecide(ctx.request, ctx.correlationId, input.params.sessionId, input.body) },
    revoke: { handle: (input, ctx) => breakGlass.customerRevoke(ctx.request, ctx.correlationId, input.params.sessionId) },
    policy: { handle: (_input, ctx) => breakGlass.policy(ctx.request) },
    setPolicy: { handle: (input, ctx) => breakGlass.setPolicy(ctx.request, ctx.correlationId, input.body.approvalRequired) },
  };
}
