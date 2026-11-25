import { Router } from 'express';
import * as render from '../controllers/render.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/render.schema';

export const renderRouter: Router = Router();

renderRouter.use(requireAuth);

/*
 * NO PERMISSION BEYOND MEMBERSHIP. What somebody chose to look at is their own
 * preference about their own screen, and the row holds two archetype names and
 * a reference — nothing anybody could be granted access to.
 */
renderRouter.post('/', writeLimit, validate({ body: schema.recordSelection }), render.record);

renderRouter.post(
  '/override',
  writeLimit,
  validate({ body: schema.overrideSelection }),
  render.override,
);

renderRouter.get('/override-rates', render.overrideRates);

/*
 * §2 — the representation switch.
 *
 * NO RATE LIMIT ON THE READ AND ONE ON THE WRITE, which is the ordinary split.
 * §2 says switching "costs nothing and never recomputes" — that is true of the
 * switch itself, which happens entirely in the client from one result object.
 * This records the preference so the next opening starts where the person left
 * off, and it is a write like any other.
 */
renderRouter.put(
  '/representation',
  writeLimit,
  validate({ body: schema.preferRepresentation }),
  render.preferRepresentation,
);

renderRouter.get(
  '/representation/:id',
  validate({ params: schema.viewId }),
  render.representationFor,
);

/*
 * §5 and §6 — the interactions worth a trail.
 *
 * NEITHER READS ANYTHING. A drill fetches its records through the query path
 * with the reader's own permissions; a flag opens detail the result already
 * carries. These say it happened, which is the only source for how often
 * either does.
 */
renderRouter.post('/drills', writeLimit, validate({ body: schema.recordDrill }), render.recordDrill);

renderRouter.post(
  '/flags',
  writeLimit,
  validate({ body: schema.recordFlagOpened }),
  render.recordFlagOpened,
);
