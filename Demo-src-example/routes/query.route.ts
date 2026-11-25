import { Router } from 'express';
import * as query from '../controllers/query.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requireCapability, requirePermission } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/query.schema';

/**
 * Asking questions of connected systems.
 *
 * `query.run` RATHER THAN `connection.create`. Reading from a connection is what
 * an ordinary member does; building one is not. Which connections a member can
 * actually reach is decided below this, by `connection_grants`.
 */
export const queryRouter: Router = Router();

queryRouter.use(requireAuth);

/*
 * §15.3 — "Cancelled: queries stop."
 *
 * THE LADDER WAS WRITTEN DOWN AND ENFORCED NOWHERE. `capabilitiesFor` has said
 * since 001 that a cancelled account cannot query, `requireCapability` has
 * existed to act on it, and no router mounted it — so the one state in the
 * ladder that is supposed to stop reading did not stop anything.
 *
 * ON THE ROUTER, NOT PER ROUTE, so a route added later inherits it. Export and
 * history are deliberately NOT behind this: §15.3 binds that they are never
 * withheld, and `canExport` stays true through cancellation for exactly that
 * reason.
 */
queryRouter.use(requireCapability('canQuery'));

queryRouter.get('/catalogue', requirePermission('query.run'), query.catalogue);

/*
 * RATE LIMITED LIKE A WRITE, THOUGH IT WRITES NOTHING. One call fans out to
 * every connection the caller can reach and makes a real request to each — the
 * cost lands on the customer's own systems, not on ours, which is exactly the
 * case for a limit rather than against one.
 */
queryRouter.post(
  '/',
  writeLimit,
  requirePermission('query.run'),
  validate({ body: schema.ask }),
  query.run,
);
