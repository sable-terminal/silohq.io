// The credential service's entity graph hashes: the organisation from the request context,
// the values to the organisation key and the hashes back. Nothing is logged but counts.

import type { hashForEntityGraph } from '../../contracts/credential/entityHash.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { OrganisationKeys } from '../../services/credential/organisationKey.service.ts';

export function entityHashController(keys: OrganisationKeys): { hash: RouteHandlers<typeof hashForEntityGraph> } {
  return {
    hash: {
      handle: (input, ctx) => keys.hash(ctx.request.organisationId!, input.body.purpose, input.body.values),
    },
  };
}
