import { Router } from 'express';
import * as discovery from '../controllers/discovery.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/discovery.schema';

/**
 * §9 — agent discovery.
 *
 * THIS ROUTER IS ONLY MOUNTED WHEN THE BUILD INCLUDES IT. "Off means
 * unreachable, not idle" — in a sovereign build the paths below do not exist and
 * return 404 like any other unknown URL, rather than existing and refusing.
 *
 * `discovery.manage` IS HELD BY SUPER ADMINS AND BY NOBODY ELSE. §9.1 — a scope
 * admin administers part of a network, and letting them authorise a scan of it
 * would let them authorise scanning the parts they do not administer.
 */
export const discoveryRouter: Router = Router();

discoveryRouter.use(requireAuth, requirePermission('discovery.manage'));

discoveryRouter.put(
  '/settings',
  writeLimit,
  validate({ body: schema.setEnabled }),
  discovery.setEnabled,
);

discoveryRouter.post(
  '/authorisations',
  writeLimit,
  validate({ body: schema.authorise }),
  discovery.authorise,
);

discoveryRouter.delete(
  '/authorisations/:id',
  writeLimit,
  validate({ params: schema.authorisationId }),
  discovery.revoke,
);

discoveryRouter.post(
  '/runs',
  writeLimit,
  validate({ body: schema.startRun }),
  discovery.startRun,
);

discoveryRouter.post(
  '/runs/report',
  writeLimit,
  validate({ body: schema.report }),
  discovery.report,
);

discoveryRouter.get('/runs', discovery.runs);

discoveryRouter.get('/findings', validate({ query: schema.runFilter }), discovery.findings);

discoveryRouter.post(
  '/findings/:id/decision',
  writeLimit,
  validate({ params: schema.findingId, body: schema.decide }),
  discovery.decide,
);
