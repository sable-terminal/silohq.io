// planner (spec 27.2): decomposes a validated plan into source steps per system against the
// reader's access now, and states its bounds. The executor runs the same modules in its own
// process (the catalogue: planner starts inside executor); this service answers compile's
// bounds stage.

import { explainPlan } from '../../contracts/planner/plan.contract.ts';
import { planController } from '../../controllers/planner/plan.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';

export const service = defineService({
  name: 'planner',
  // control: the organisation's calendar, for period resolution.
  needs: { postgres: ['control'] },
  create(deps) {
    const c = planController({ databases: deps.databases, services: deps.services, bounds: deps.config.executorBounds, logger: deps.logger });
    return { routes: [route(explainPlan, c.explainPlan)] };
  },
});
