// catalogue (catalogue): browsing connectors, and Silo's prebuilt connectors from signed
// releases. Browsing on the control pool under row-level security; the release path on the
// catalogue's migration login (CATALOGUE_DATABASE_URL), acting as silo_migrate.

import { browseCatalogue, installCatalogueRelease, installConceptTemplates } from '../../contracts/catalogue/catalogue.contract.ts';
import { catalogueController } from '../../controllers/catalogue/catalogue.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { closePool, createPool } from '../../infra/postgres.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { createCatalogue } from '../../services/catalogue/catalogue.service.ts';

export const service = defineService({
  name: 'catalogue',
  needs: { postgres: ['control'] },
  create(deps) {
    const url = deps.config.catalogue?.databaseUrl;
    const migrate = url === undefined ? undefined
      : createPool({ ...deps.config.postgres, controlUrl: url, poolMax: 2 }, 'control', 'catalogue', { logger: deps.logger });
    const catalogue = createCatalogue({
      databases: deps.databases, migrate, services: deps.services, logger: deps.logger, releasePublicKey: deps.config.catalogue?.releasePublicKey,
    });
    const c = catalogueController(catalogue);
    return {
      routes: [
        route(browseCatalogue, c.browse), route(installCatalogueRelease, c.install), route(installConceptTemplates, c.installTemplates),
      ],
      close: async () => {
        if (migrate !== undefined) await closePool(migrate);
      },
    };
  },
});
