import { Router } from 'express';
import * as terminology from '../controllers/terminology.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/terminology.schema';

/**
 * §12 — terminology skins and the per-user lens.
 *
 * TWO PATHS, TWO DIFFERENT THINGS, AND THE SPLIT IS THE POINT. `/skin` changes
 * what everybody in the organisation is shown and needs `terminology.manage`.
 * `/lens` changes what the caller alone is shown and needs no permission at
 * all — it is a preference, and requiring a grant to hold one would be the
 * product telling somebody what to call their own work.
 */
export const terminologyRouter: Router = Router();

terminologyRouter.use(requireAuth);

terminologyRouter.get('/', terminology.list);

terminologyRouter.put('/skin', writeLimit, validate({ body: schema.setTerm }), terminology.setSkin);
terminologyRouter.delete(
  '/skin/:conceptId',
  writeLimit,
  validate({ params: schema.conceptId }),
  terminology.clearSkin,
);

terminologyRouter.put('/lens', writeLimit, validate({ body: schema.setTerm }), terminology.setLens);
terminologyRouter.delete(
  '/lens/:conceptId',
  writeLimit,
  validate({ params: schema.conceptId }),
  terminology.clearLens,
);
