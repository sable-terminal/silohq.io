import { Router } from 'express';
import { z } from 'zod';
import * as resolution from '../controllers/resolution.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/resolution.schema';

export const resolutionRouter: Router = Router();

resolutionRouter.use(requireAuth);

const pairId = z.object({ id: z.string().uuid() }).strict();

/*
 * DECIDING A PAIR IS `concept.confirm`, checked in the service. It is the same
 * act as confirming a concept — saying what is the same as what — and a
 * confirmed pair is exact from that moment on, which is at least as
 * consequential as the concept it hangs off.
 */
resolutionRouter.get('/', validate({ query: schema.openQuestions }), resolution.open);

/*
 * PROPOSING CALLS THE MODEL, so it is rate limited like a write even though the
 * row it touches stays open. §5.4's reasoning applied one layer down.
 */
resolutionRouter.post(
  '/:id/propose',
  writeLimit,
  validate({ params: pairId, body: schema.proposeMatch }),
  resolution.propose,
);

resolutionRouter.post(
  '/:id/confirm',
  writeLimit,
  validate({ params: pairId }),
  resolution.confirm,
);

resolutionRouter.post(
  '/:id/reject',
  writeLimit,
  validate({ params: pairId }),
  resolution.reject,
);
