// The search service's endpoints: contracts to the vocabulary and federated searches.

import type { searchObjects, searchVocabulary } from '../../contracts/search/search.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { SearchDeps } from '../../services/search/deps.service.ts';
import * as objects from '../../services/search/objects.service.ts';
import * as vocabulary from '../../services/search/vocabulary.service.ts';

export function searchController(deps: SearchDeps): {
  searchVocabulary: RouteHandlers<typeof searchVocabulary>;
  searchObjects: RouteHandlers<typeof searchObjects>;
} {
  return {
    searchVocabulary: { handle: (input, ctx) => vocabulary.searchVocabulary(deps, ctx, input.body) },
    searchObjects: { handle: (input, ctx) => objects.searchObjects(deps, ctx, input.body) },
  };
}
