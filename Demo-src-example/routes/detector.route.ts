import { Router } from 'express';
import * as detector from '../controllers/detector.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/detector.schema';
import { z } from 'zod';

export const detectorRouter: Router = Router();

detectorRouter.use(requireAuth);

/*
 * RATE LIMITED LIKE A WRITE, THOUGH IT WRITES ONLY FINDINGS. One run fans out to
 * every connection a concept touches and makes a real request to each — the
 * cost lands on the customer's own systems, which is the case for a limit
 * rather than against one. The same reasoning `/query` already applies.
 */
detectorRouter.post(
  '/run',
  writeLimit,
  requirePermission('query.run'),
  validate({ body: schema.runDetectors }),
  detector.run,
);

detectorRouter.get(
  '/',
  requirePermission('query.run'),
  validate({ query: schema.listFindings }),
  detector.list,
);

/*
 * DECIDING NEEDS ONLY THAT YOU CAN SEE IT. §6.6 — a disposition is silenced for
 * the person, not the organisation, so it changes nothing for anybody else and
 * needs no permission beyond the one that let them read the finding.
 */
detectorRouter.post(
  '/:id/disposition',
  validate({ params: z.object({ id: z.string().uuid() }).strict(), body: schema.decideFinding }),
  detector.decide,
);
