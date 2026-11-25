// search (spec 24.5, 33.5, 34.1): ontology search over the person's vocabulary, and federated
// object search pushed to each contributing system. Typed filters, never a compile: no model
// call, never metered. The Object Index adapter waits for its engine decision (spec 69.6).

import { searchObjects, searchVocabulary } from '../../contracts/search/search.contract.ts';
import { searchController } from '../../controllers/search/search.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { ManifestCache } from '../../services/search/deps.service.ts';

export const service = defineService({
  name: 'search',
  needs: { postgres: ['control'] },
  create(deps) {
    const c = searchController({ databases: deps.databases, services: deps.services, logger: deps.logger, manifests: new ManifestCache() });
    return { routes: [route(searchVocabulary, c.searchVocabulary), route(searchObjects, c.searchObjects)] };
  },
});
