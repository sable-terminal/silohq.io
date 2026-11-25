import { Router } from 'express';
import * as notification from '../controllers/notification.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import * as schema from '../schemas/notification.schema';

/**
 * The bell.
 *
 * NO CAPABILITY AND NO PERMISSION. Being told what happened to your own work is
 * not a feature of a plan, and a cancelled account is exactly the account that
 * needs to read the last thing it was told.
 */
export const notificationRouter: Router = Router();

notificationRouter.use(requireAuth);

notificationRouter.get('/', notification.mine);
notificationRouter.post('/read', notification.markAllRead);
notificationRouter.post('/:id/read', validate({ params: schema.notificationId }), notification.markRead);
