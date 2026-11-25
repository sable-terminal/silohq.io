// revert (catalogue): the final stage of the mutation path (spec 46.3 to 46.7). A revert is a
// mutation: computed three-way here, approved by the approvals service, executed by actions.

import { decideRevertConflicts, getRevert, requestRevert } from '../../contracts/revert/revert.contract.ts';
import { revertController } from '../../controllers/revert/revert.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { createReverts } from '../../services/revert/revert.service.ts';

export const service = defineService({
  name: 'revert',
  // redis-data holds the keys of keyed revert requests.
  needs: { postgres: ['control'], redis: ['data'] },
  create(deps) {
    const c = revertController(createReverts({ databases: deps.databases, services: deps.services, logger: deps.logger }));
    return { routes: [route(requestRevert, c.request), route(getRevert, c.get), route(decideRevertConflicts, c.decide)] };
  },
});
