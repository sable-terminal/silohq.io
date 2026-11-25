import { Router } from 'express';
import * as search from '../controllers/search.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import * as schema from '../schemas/search.schema';

/**
 * Finding something by name.
 *
 * `requireAuth` AND NOTHING ELSE. There is no `search.read` permission and
 * there must not be one: every kind this returns is already reachable from a
 * page, and each is scoped in `search.service` by the same rule as the list it
 * links to. A permission in front of the whole endpoint would be a second,
 * coarser answer to a question seven finer ones have already settled — and the
 * first time the two disagreed, one of them would be wrong.
 *
 * NO `requireCapability` EITHER, THOUGH THREE OF THE KINDS NEED ONE. A
 * cancelled account can still reach its connections, its concepts and its
 * colleagues; gating the whole router on `canQuery` would take away the search
 * box rather than the three kinds that stop, so the service drops those and
 * keeps the rest.
 *
 * NO `writeLimit`: this writes nothing. The general limiter in `app.ts` covers
 * it like every other read.
 */
export const searchRouter: Router = Router();

searchRouter.use(requireAuth);

searchRouter.get('/', validate({ query: schema.search }), search.find);
