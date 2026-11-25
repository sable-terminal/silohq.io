// The pushdown compiler (catalogue: pushdown-compiler): plan steps into each protocol's
// native filter, sort and aggregate, from what the manifest declares.

import { explainPushdown } from '../../contracts/pushdown-compiler/pushdown.contract.ts';
import { pushdownController } from '../../controllers/pushdown-compiler/pushdown.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';

export const service = defineService({
  name: 'pushdown-compiler',
  needs: { postgres: ['control'] },
  create(deps) {
    return { routes: [route(explainPushdown, pushdownController({ databases: deps.databases, services: deps.services, bounds: deps.config.executorBounds }))] };
  },
});
