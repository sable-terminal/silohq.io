import { Router } from 'express';
import * as seat from '../controllers/seat.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/seat.schema';

export const seatRouter: Router = Router();

seatRouter.use(requireAuth);

/**
 * EVERY MEMBER MAY SEE THE COUNTS. "Are we out of licences" is the explanation
 * for a refusal somebody has just hit, and hiding it means the only way to learn
 * why an invitation failed is to ask the person who can see the number.
 */
seatRouter.get('/', seat.summary);

seatRouter.post(
  '/allocations',
  writeLimit,
  requirePermission('seat.allocate'),
  validate({ body: schema.allocate }),
  seat.allocate,
);

seatRouter.delete(
  '/allocations/:seatId',
  writeLimit,
  requirePermission('seat.allocate'),
  validate({ params: schema.seatParams }),
  seat.reclaim,
);

/**
 * ADDING COSTS MONEY AND GIVING UP DOES TOO, so neither is `seat.allocate`.
 * The person who arranges who sits where is not automatically the person who
 * may change the bill.
 */
seatRouter.post(
  '/',
  writeLimit,
  requirePermission('billing.manage'),
  validate({ body: schema.add }),
  seat.add,
);

seatRouter.delete(
  '/:seatId',
  writeLimit,
  requirePermission('seat.release'),
  validate({ params: schema.seatParams }),
  seat.retire,
);
