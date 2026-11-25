// revert's endpoints: parsed input to the revert service and back.

import type { decideRevertConflicts, getRevert, requestRevert } from '../../contracts/revert/revert.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { Reverts } from '../../services/revert/revert.service.ts';

export function revertController(reverts: Reverts) {
  return {
    request: {
      handle: ({ body }, ctx) => reverts.request(ctx, body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => reverts.get(ctx, ref!),
    } satisfies RouteHandlers<typeof requestRevert>,
    get: { handle: ({ params }, ctx) => reverts.get(ctx, params.revertId) } satisfies RouteHandlers<typeof getRevert>,
    decide: { handle: ({ params, body }, ctx) => reverts.decide(ctx, params.revertId, body.decisions) } satisfies RouteHandlers<typeof decideRevertConflicts>,
  };
}
