// catalogue's endpoints: parsed input to the catalogue service and back.

import type { browseCatalogue, installCatalogueRelease, installConceptTemplates } from '../../contracts/catalogue/catalogue.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { Catalogue } from '../../services/catalogue/catalogue.service.ts';

export function catalogueController(catalogue: Catalogue) {
  return {
    browse: {
      handle: async ({ query }, ctx) => ({ connectors: await catalogue.browse(ctx, query) }),
    } satisfies RouteHandlers<typeof browseCatalogue>,
    install: {
      handle: ({ body }) => catalogue.install(body.release, body.signature, body.keyId),
    } satisfies RouteHandlers<typeof installCatalogueRelease>,
    installTemplates: {
      handle: ({ body }, ctx) => catalogue.installConceptTemplates(body.set, body.signatures, ctx.correlationId),
    } satisfies RouteHandlers<typeof installConceptTemplates>,
  };
}
