// connect-registry: private links (contracts/connect-registry/privateLink.contract.ts).

import type { addPrivateLink, listPrivateLinks, removePrivateLink } from '../../contracts/connect-registry/privateLink.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { PrivateLinks } from '../../services/connect-registry/privateLinks.service.ts';

export function privateLinkController(links: PrivateLinks) {
  return {
    listPrivateLinks: {
      handle: ({ query }, ctx) => links.list(ctx, query.includeRemoved === 'true'),
    } satisfies RouteHandlers<typeof listPrivateLinks>,
    addPrivateLink: {
      handle: ({ body }, ctx) => links.add(ctx, body),
    } satisfies RouteHandlers<typeof addPrivateLink>,
    removePrivateLink: {
      handle: ({ params, body }, ctx) => links.remove(ctx, params.linkId, body),
    } satisfies RouteHandlers<typeof removePrivateLink>,
  };
}
