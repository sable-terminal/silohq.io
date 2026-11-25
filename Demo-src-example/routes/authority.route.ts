import { Router } from 'express';
import { z } from 'zod';
import * as authority from '../controllers/authority.controller';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission } from '../middleware/authorise.middleware';
import { validate } from '../middleware/validate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/authority.schema';

export const authorityRouter: Router = Router();

authorityRouter.use(requireAuth);

/*
 * READING NEEDS NO PERMISSION BEYOND MEMBERSHIP. Which system decides a field
 * is a fact about how this organisation's answers are put together, and
 * somebody handed a figure is entitled to know what produced it. The concepts
 * it names are already bounded by what the reader can reach.
 */
authorityRouter.get(
  '/',
  validate({ query: schema.listAuthorities }),
  authority.list,
);

/*
 * §2.8 — DECLARING ONE IS NOT DELEGABLE. `authority.declare` is
 * `scopeable = false` in 053 for the same reason `outcome.designate` is: it
 * decides what every later answer says a number IS, across the whole
 * organisation. A scope admin setting it for their own department would be
 * deciding the organisation's figures from inside one corner of it.
 */
authorityRouter.post(
  '/',
  writeLimit,
  requirePermission('authority.declare'),
  validate({ body: schema.declareAuthority }),
  authority.declare,
);

/*
 * §2.3 — FIELD CORRECTIONS, which are a different act from deciding authority.
 *
 * `concept.confirm` RATHER THAN `authority.declare`. Naming a column is part of
 * saying what a system holds, which is what confirming a concept is — and
 * unlike deciding WHICH system is right, it is bounded by the connections a
 * scope admin can already reach, so it is delegable for the same reason
 * `concept.confirm` is.
 */
authorityRouter.get(
  '/corrections',
  validate({ query: schema.listCorrections }),
  authority.corrections,
);

authorityRouter.post(
  '/corrections',
  writeLimit,
  requirePermission('concept.confirm'),
  validate({ body: schema.correctField }),
  authority.correctField,
);

authorityRouter.delete(
  '/corrections/:id',
  writeLimit,
  requirePermission('concept.confirm'),
  validate({ params: z.object({ id: z.string().uuid() }).strict() }),
  authority.removeCorrection,
);

/*
 * §7.3 — TIME FIELDS, registered before `/:id` like the corrections above.
 *
 * `concept.confirm` RATHER THAN `authority.declare`. Saying that a column is
 * when something happened is part of saying what a system holds; deciding
 * WHICH system is right about a value is a different act with a different
 * blast radius.
 */
authorityRouter.get(
  '/time-fields',
  validate({ query: schema.timeFieldParams }),
  authority.timeFields,
);

authorityRouter.post(
  '/time-fields',
  writeLimit,
  requirePermission('concept.confirm'),
  validate({ body: schema.declareTimeField }),
  authority.declareTimeField,
);

authorityRouter.delete(
  '/time-fields',
  writeLimit,
  requirePermission('concept.confirm'),
  validate({ body: schema.timeFieldParams.extend({ fieldPath: z.string().min(1).max(256) }) }),
  authority.removeTimeField,
);

/*
 * WITHDRAWING PUTS THE FIELD BACK IN DISPUTE wherever the systems differ, and
 * that is correct rather than a regression: taking back the statement takes
 * back the answers it was producing.
 */
authorityRouter.delete(
  '/:id',
  writeLimit,
  requirePermission('authority.declare'),
  validate({ params: z.object({ id: z.string().uuid() }).strict() }),
  authority.retire,
);

