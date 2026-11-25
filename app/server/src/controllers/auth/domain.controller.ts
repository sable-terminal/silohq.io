// auth's email domain endpoints (decision 2026-11-14): parsed input to the service.

import type { addDomain, listDomains, removeDomain, verifyDomain } from '../../contracts/auth/domain.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { AuthDeps } from '../../services/auth/deps.service.ts';
import * as domains from '../../services/auth/domains.service.ts';

export function domainController(deps: AuthDeps): {
  listDomains: RouteHandlers<typeof listDomains>;
  addDomain: RouteHandlers<typeof addDomain>;
  verifyDomain: RouteHandlers<typeof verifyDomain>;
  removeDomain: RouteHandlers<typeof removeDomain>;
} {
  return {
    listDomains: { handle: (_input, ctx) => domains.listDomains(deps, ctx) },
    addDomain: { handle: (input, ctx) => domains.addDomain(deps, ctx, input.body) },
    verifyDomain: { handle: (input, ctx) => domains.verifyDomain(deps, ctx, input.params.domainId) },
    removeDomain: {
      handle: async (input, ctx) => {
        await domains.removeDomain(deps, ctx, input.params.domainId);
      },
    },
  };
}
