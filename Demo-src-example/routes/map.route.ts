import { Router } from 'express';
import { z } from 'zod';
import * as map from '../controllers/map.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/map.schema';

export const mapRouter: Router = Router();

mapRouter.use(requireAuth);

/*
 * NO PERMISSION BEYOND MEMBERSHIP, ANYWHERE IN THIS ROUTER, and that is §6.2
 * rather than an oversight. A map belongs to a person and holds only their own
 * counts; there is nothing in it somebody could be granted access to that they
 * did not put there themselves.
 *
 * WHAT A MAP REFERENCES IS A DIFFERENT QUESTION, and it is answered on open:
 * §6.4's re-check resolves every element against the opener's own grants and
 * markings, so a shared map can never carry reach its recipient does not have.
 * The service holds that, because the service is where `readableIds` lives.
 */
const id = z.object({ id: z.string().uuid() }).strict();

mapRouter.get('/', map.list);

mapRouter.post('/', writeLimit, validate({ body: schema.createMap }), map.create);

mapRouter.get('/:id', validate({ params: id }), map.open);

mapRouter.post('/:id/activate', writeLimit, validate({ params: id }), map.activate);

mapRouter.delete('/:id', writeLimit, validate({ params: id }), map.archive);

mapRouter.post(
  '/:id/shares',
  writeLimit,
  validate({ params: id, body: schema.shareMap }),
  map.share,
);

mapRouter.delete(
  '/shares/:shareId',
  writeLimit,
  validate({ params: z.object({ shareId: z.string().uuid() }).strict() }),
  map.revokeShare,
);
