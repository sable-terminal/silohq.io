// The declassification endpoints (spec 58.9): contracts to the policy service's declassification.

import type * as d from '../../contracts/policy/declassification.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as declassification from '../../services/policy/declassification.service.ts';
import type { AdminDeps } from '../../services/policy/deps.service.ts';

export function declassificationController(deps: AdminDeps): {
  requestDeclassification: RouteHandlers<typeof d.requestDeclassification>;
  getDeclassification: RouteHandlers<typeof d.getDeclassification>;
  listDeclassifications: RouteHandlers<typeof d.listDeclassifications>;
  executeDeclassification: RouteHandlers<typeof d.executeDeclassification>;
  revertDeclassification: RouteHandlers<typeof d.revertDeclassification>;
} {
  return {
    requestDeclassification: { handle: (input, ctx) => declassification.requestDeclassification(deps, ctx, input.body) },
    getDeclassification: { handle: (input, ctx) => declassification.getDeclassification(deps, ctx, input.params.declassificationId) },
    listDeclassifications: {
      handle: async (input, ctx) => ({ declassifications: await declassification.listDeclassifications(deps, ctx, input.query.limit) }),
    },
    executeDeclassification: { handle: (input, ctx) => declassification.executeDeclassification(deps, ctx, input.params.declassificationId) },
    revertDeclassification: { handle: (input, ctx) => declassification.revertDeclassification(deps, ctx, input.params.declassificationId) },
  };
}
