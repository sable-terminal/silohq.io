import { Router } from 'express';
import * as dashboard from '../controllers/dashboard.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requireCapability } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/dashboard.schema';

/**
 * Rendering §8 — dashboards.
 *
 * `canQuery` ON THE WHOLE ROUTER, as on saved views: a dashboard is a grid of
 * questions, and a cancelled account cannot ask them.
 *
 * NO `writeLimit` ON OPENING ONE, THOUGH IT FANS OUT. Each view on it is
 * limited where every question is, inside the engine's own path.
 */
export const dashboardRouter: Router = Router();

dashboardRouter.use(requireAuth);
dashboardRouter.use(requireCapability('canQuery'));

dashboardRouter.get('/', dashboard.mine);

dashboardRouter.post('/', writeLimit, validate({ body: schema.createDashboard }), dashboard.create);

dashboardRouter.get('/:id', validate({ params: schema.dashboardId }), dashboard.open);

dashboardRouter.patch(
  '/:id',
  writeLimit,
  validate({ params: schema.dashboardId, body: schema.renameDashboard }),
  dashboard.rename,
);

dashboardRouter.delete('/:id', writeLimit, validate({ params: schema.dashboardId }), dashboard.remove);

dashboardRouter.post(
  '/:id/widgets',
  writeLimit,
  validate({ params: schema.dashboardId, body: schema.addWidget }),
  dashboard.addWidget,
);

dashboardRouter.delete(
  '/:id/widgets/:widgetId',
  writeLimit,
  validate({ params: schema.widgetId }),
  dashboard.removeWidget,
);

/* Order and sizes together, sent once a drag or a resize ends. */
dashboardRouter.put(
  '/:id/layout',
  writeLimit,
  validate({ params: schema.dashboardId, body: schema.arrangeWidgets }),
  dashboard.arrange,
);
