// connect-registry: a Silo as a source (contracts/connect-registry/siloSource.contract.ts).

import type { registerSiloSource, retireSiloSource } from '../../contracts/connect-registry/siloSource.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { RegistryDeps } from '../../services/connect-registry/registry.service.ts';
import * as silo from '../../services/connect-registry/siloSource.service.ts';

export function siloSourceController(deps: RegistryDeps) {
  return {
    registerSiloSource: {
      handle: ({ params, body }, ctx) => silo.registerSiloSource(deps, ctx, params.siloId, body),
    } satisfies RouteHandlers<typeof registerSiloSource>,
    retireSiloSource: {
      handle: ({ params, body }, ctx) => silo.retireSiloSource(deps, ctx, params.siloId, body.move),
    } satisfies RouteHandlers<typeof retireSiloSource>,
  };
}
