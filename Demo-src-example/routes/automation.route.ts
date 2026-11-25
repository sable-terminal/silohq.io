import { Router } from 'express';
import * as automation from '../controllers/automation.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requireCapability } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/automation.schema';

/**
 * Automations — "crons" in the product, §2.4.
 *
 * `canQuery`, NOT `canMutate`, AND THAT IS ABOUT BILLING RATHER THAN ABOUT
 * WRITES. `requireCapability` refuses what a tenant's billing state has switched
 * off, and creating a cron — even one that proposes a change, or one authorised
 * to write inside §5's bounds — writes nothing to a customer's systems at the
 * moment it is created. What it may eventually do is governed by permissions
 * (`automation.create`, `automation.mutate`, `automation.execute`) and by the
 * mutation path's own gates, both checked against the owner as they are at the
 * moment a run reaches them. §15.3 suspends crons on a suspended account, and
 * that is enforced where it belongs — in the runner, which refuses to run them —
 * rather than here, where it would also stop somebody reading what their own
 * paused checks are.
 *
 * RESUME IS ITS OWN ROUTE, matching §9: resuming a scheduled thing under new
 * circumstances is a decision, not the absence of pausing.
 */
export const automationRouter: Router = Router();

automationRouter.use(requireAuth);
automationRouter.use(requireCapability('canQuery'));

automationRouter.get('/', automation.mine);

/*
 * §4 — BEFORE `/:id`, or Express reads "escalations" as an automation id and
 * the route is unreachable behind a uuid validator.
 */
automationRouter.get('/escalations', automation.outstanding);

/* §11 — the feed Home reads: what fired, across every check the caller owns. */
automationRouter.get('/fired', automation.fired);

automationRouter.post(
  '/escalations/:id/acknowledge',
  writeLimit,
  validate({ params: schema.escalationId, body: schema.acknowledgeEscalation }),
  automation.acknowledge,
);

automationRouter.post('/', writeLimit, validate({ body: schema.createAutomation }), automation.create);

automationRouter.get('/:id', validate({ params: schema.automationId }), automation.read);

automationRouter.get('/:id/runs', validate({ params: schema.automationId }), automation.history);

automationRouter.post('/:id/pause', writeLimit, validate({ params: schema.automationId }), automation.pause);

automationRouter.post('/:id/resume', writeLimit, validate({ params: schema.automationId }), automation.resume);

automationRouter.delete('/:id', writeLimit, validate({ params: schema.automationId }), automation.remove);

/*
 * §5 — the only unattended write in the product, behind `automation.execute`,
 * which §10 says "should be rare". Its own route rather than a field on the
 * automation: authorising is a decision with a name and a date on it, and
 * PATCHing it alongside a rename would not be.
 */
automationRouter.post(
  '/:id/authorisation',
  writeLimit,
  validate({ params: schema.automationId, body: schema.authoriseExecution }),
  automation.authorise,
);

automationRouter.delete(
  '/:id/authorisation',
  writeLimit,
  validate({ params: schema.automationId }),
  automation.revokeAuthorisation,
);
