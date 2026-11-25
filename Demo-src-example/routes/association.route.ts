import { Router } from 'express';
import { z } from 'zod';
import * as association from '../controllers/association.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/association.schema';

export const associationRouter: Router = Router();

associationRouter.use(requireAuth);

/*
 * COMPUTING REACHES NO SYSTEM. Unlike a detector run, this reads findings that
 * are already in the database and writes a table — so it is rate limited as a
 * write rather than as a fan-out, and it needs what reading findings needs.
 */
associationRouter.post(
  '/compute',
  writeLimit,
  requirePermission('query.run'),
  validate({ body: schema.computeAssociations }),
  association.compute,
);

associationRouter.get('/', requirePermission('query.run'), association.list);

/*
 * §4.3 — `outcome.designate` is not scopeable. "Late delivery is what we care
 * about" is a claim about the business, and every ranking anybody sees is
 * ordered by it; a subtree admin making it organisation-wide is the wrong blast
 * radius. The permission catalogue says the same in 033.
 */
associationRouter.get('/outcomes', association.designations);

associationRouter.post(
  '/outcomes',
  writeLimit,
  requirePermission('outcome.designate'),
  validate({ body: schema.designateOutcome }),
  association.designate,
);

associationRouter.delete(
  '/outcomes/:id',
  writeLimit,
  requirePermission('outcome.designate'),
  validate({ params: z.object({ id: z.string().uuid() }).strict() }),
  association.retire,
);
