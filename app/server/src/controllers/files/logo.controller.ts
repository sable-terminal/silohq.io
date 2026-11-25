// The organisation logo's endpoints (spec 56.2).

import type { getOrganisationLogo, setOrganisationLogo } from '../../contracts/files/logo.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { FilesDeps } from '../../services/files/deps.service.ts';
import { getLogo, setLogo } from '../../services/files/logo.service.ts';

export function logoController(deps: FilesDeps) {
  return {
    set: { handle: ({ body }, ctx) => setLogo(deps, ctx, body.contentBase64) } satisfies RouteHandlers<typeof setOrganisationLogo>,
    get: { handle: (_input, ctx) => getLogo(deps, ctx) } satisfies RouteHandlers<typeof getOrganisationLogo>,
  };
}
