import { Router } from 'express';
import * as savedView from '../controllers/savedView.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requireCapability, requirePermission } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/savedView.schema';

/**
 * §7 — saved views.
 *
 * `canQuery` ON THE WHOLE ROUTER, INCLUDING THE READS. A saved view is a
 * question, and §15.3 stops a cancelled account asking them — listing the
 * questions you can no longer ask would be a menu of refusals.
 *
 * NO `writeLimit` ON `run`, THOUGH IT FANS OUT. It is rate limited where every
 * other question is, inside the engine's own path; putting a write limiter on
 * the one endpoint whose entire purpose is to be cheap to re-run would
 * contradict §7's commercial claim in the middleware.
 */
export const savedViewRouter: Router = Router();

savedViewRouter.use(requireAuth);
savedViewRouter.use(requireCapability('canQuery'));

savedViewRouter.get('/', savedView.mine);

savedViewRouter.post('/', writeLimit, validate({ body: schema.createSavedView }), savedView.create);

/*
 * AUTH rev 7 — what other people shared with you.
 *
 * BEFORE `/:id`, for the reason the dashboard route is: Express matches in
 * order, and `shared` would otherwise be read as a view id.
 */
savedViewRouter.get('/shared', savedView.sharedWithMe);

/*
 * rev 7 — the views an admin inherited from somebody who left.
 *
 * BEFORE `/:id`, for the same reason `/shared` is: Express matches in order.
 *
 * NO `requirePermission`. The queue is what was handed to this membership and
 * nothing else, and the permission that decided that was the one that made them
 * an admin over the person who left. A gate here could hand somebody a view and
 * then refuse to show it to them.
 */
savedViewRouter.get('/inherited', savedView.inherited);

savedViewRouter.post(
  '/inherited/:flagId/review',
  writeLimit,
  validate({ params: schema.transferFlagId, body: schema.reviewTransfer }),
  savedView.review,
);

/* "That is a second action." A separate route, so it cannot be taken by accident. */
savedViewRouter.post(
  '/inherited/:flagId/crons/:automationId/resume',
  writeLimit,
  validate({ params: schema.transferCron }),
  savedView.resumeCron,
);

savedViewRouter.get('/:id', validate({ params: schema.savedViewId }), savedView.read);

savedViewRouter.post('/:id/run', validate({ params: schema.savedViewId }), savedView.run);

savedViewRouter.patch(
  '/:id',
  writeLimit,
  validate({ params: schema.savedViewId, body: schema.renameSavedView }),
  savedView.rename,
);

savedViewRouter.delete('/:id', writeLimit, validate({ params: schema.savedViewId }), savedView.remove);

/* rev 7 — sharing is an act the owner takes, inside the organisation's policy. */
savedViewRouter.post(
  '/:id/shares',
  writeLimit,
  requirePermission('view.share'),
  validate({ params: schema.savedViewId, body: schema.shareView }),
  savedView.share,
);

savedViewRouter.get('/:id/shares', validate({ params: schema.savedViewId }), savedView.shares);

savedViewRouter.delete(
  '/:id/shares/:shareId',
  writeLimit,
  validate({ params: schema.shareId }),
  savedView.revokeShare,
);
