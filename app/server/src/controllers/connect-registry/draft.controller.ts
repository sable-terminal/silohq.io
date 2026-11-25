// connect-registry: a connection being built follows its draft version.

import type { setDraftConnectionVersion } from '../../contracts/connect-registry/draft.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as draft from '../../services/connect-registry/draft.service.ts';
import type { RegistryDeps } from '../../services/connect-registry/registry.service.ts';

export function draftController(deps: RegistryDeps) {
  return {
    setDraftConnectionVersion: {
      handle: ({ params, body }, ctx) => draft.setDraftConnectionVersion(deps, ctx, params.connectionId, body),
    } satisfies RouteHandlers<typeof setDraftConnectionVersion>,
  };
}
