// The actuation allow-list (spec 47.4): wire to the service and back.

import type { decideAllowlistRequest, listAllowlist, removeAllowlistEntry, requestAllowlistEntry } from '../../contracts/actions/allowlist.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { Allowlist } from '../../services/actions/allowlist.service.ts';

export function allowlistController(allowlist: Allowlist) {
  return {
    request: { handle: ({ params, body }, ctx) => allowlist.request(ctx, params.connectionId, body) } satisfies RouteHandlers<typeof requestAllowlistEntry>,
    decide: { handle: ({ params, body }, ctx) => allowlist.decide(ctx, params.requestId, body.decision) } satisfies RouteHandlers<typeof decideAllowlistRequest>,
    list: { handle: ({ params }, ctx) => allowlist.list(ctx, params.connectionId) } satisfies RouteHandlers<typeof listAllowlist>,
    remove: { handle: ({ params }, ctx) => allowlist.remove(ctx, params.entryId) } satisfies RouteHandlers<typeof removeAllowlistEntry>,
  };
}
