import { Router } from 'express';
import { z } from 'zod';
import * as ranking from '../controllers/ranking.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/ranking.schema';

export const rankingRouter: Router = Router();

rankingRouter.use(requireAuth);

/*
 * §5.4 — A COMPILE-CLASS OPERATION, so it is limited like one. It calls the
 * model on every invocation and will be run repeatedly during exploration,
 * which is exactly the case the rephrase rule exists for; until metering is
 * built, the rate limit is the only thing standing between exploration and a
 * bill nobody expected.
 */
rankingRouter.post(
  '/',
  writeLimit,
  requirePermission('query.run'),
  validate({ body: schema.rankFindings }),
  ranking.rank,
);

/* The ranking as somebody was shown it, which is what answers a challenge. */
rankingRouter.get(
  '/:id',
  requirePermission('query.run'),
  validate({ params: z.object({ id: z.string().uuid() }).strict() }),
  ranking.read,
);
