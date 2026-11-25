// The auth service's SCIM endpoints: contracts to services/auth/scim.

import type {
  createScimGroupMapping, issueScimToken, listScimGroups, listScimTokens, removeScimGroupMapping, revokeScimToken, scimRequest,
} from '../../contracts/auth/scim.contract.ts';
import * as groups from '../../services/auth/scimGroups.service.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { AuthDeps } from '../../services/auth/deps.service.ts';
import * as scim from '../../services/auth/scim.service.ts';

export function scimController(deps: AuthDeps): {
  scimRequest: RouteHandlers<typeof scimRequest>;
  listScimGroups: RouteHandlers<typeof listScimGroups>;
  createScimGroupMapping: RouteHandlers<typeof createScimGroupMapping>;
  removeScimGroupMapping: RouteHandlers<typeof removeScimGroupMapping>;
  issueScimToken: RouteHandlers<typeof issueScimToken>;
  listScimTokens: RouteHandlers<typeof listScimTokens>;
  revokeScimToken: RouteHandlers<typeof revokeScimToken>;
} {
  return {
    scimRequest: { handle: (input, ctx) => scim.handleScim(deps, input.body, ctx.correlationId) },
    listScimGroups: { handle: (_input, ctx) => groups.listScimGroups(deps, ctx) },
    createScimGroupMapping: { handle: (input, ctx) => groups.createScimGroupMapping(deps, ctx, input.body) },
    removeScimGroupMapping: {
      handle: async (input, ctx) => {
        await groups.removeScimGroupMapping(deps, ctx, input.params.mappingId);
      },
    },
    issueScimToken: { handle: (_input, ctx) => scim.issueToken(deps, ctx) },
    listScimTokens: { handle: (_input, ctx) => scim.listTokens(deps, ctx) },
    revokeScimToken: {
      async handle(input, ctx) {
        await scim.revokeToken(deps, ctx, input.params.tokenId);
        return undefined;
      },
    },
  };
}
