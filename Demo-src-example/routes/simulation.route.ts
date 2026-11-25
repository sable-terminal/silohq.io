import { Router } from 'express';
import * as simulation from '../controllers/simulation.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requireCapability } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/simulation.schema';

/**
 * Simulation §3 and §5.
 *
 * `canQuery` ON THE WHOLE ROUTER. A simulation reaches source systems exactly
 * as a question does, and §15.3 of the product spec stops a cancelled account
 * doing that. Listing scenarios is included for the reason saved views are: a
 * menu of questions you can no longer ask is not a useful screen.
 *
 * `writeLimit` ON RUNNING, THOUGH IT READS. §6 meters a run from its own
 * allowance, and the limiter is not about the money — a run fans out to several
 * systems per hop, and a loop that re-runs is somebody else's outage.
 *
 * THE PERMISSIONS ARE CHECKED IN THE SERVICE, because §7's marking rule needs
 * the concept the scenario names and middleware cannot see it.
 */
export const simulationRouter: Router = Router();

simulationRouter.use(requireAuth);
simulationRouter.use(requireCapability('canQuery'));

simulationRouter.get('/scenarios', simulation.mine);

simulationRouter.post(
  '/scenarios',
  writeLimit,
  validate({ body: schema.saveScenario }),
  simulation.save,
);

simulationRouter.delete(
  '/scenarios/:id',
  writeLimit,
  validate({ params: schema.scenarioId }),
  simulation.remove,
);

simulationRouter.post(
  '/scenarios/:id/run',
  writeLimit,
  validate({ params: schema.scenarioId }),
  simulation.run,
);

simulationRouter.get('/scenarios/:id/runs', validate({ params: schema.scenarioId }), simulation.runs);

simulationRouter.get('/runs/:id', validate({ params: schema.runId }), simulation.read);

/* §7 — sharing the question. Never the answer: §7's marking rule is applied to
   whoever runs it, so a shared scenario in less-cleared hands gives a shorter
   result rather than the owner's fuller one. */
simulationRouter.post(
  '/scenarios/:id/shares',
  writeLimit,
  validate({ params: schema.scenarioId, body: schema.shareScenario }),
  simulation.share,
);

simulationRouter.get(
  '/scenarios/:id/shares',
  validate({ params: schema.scenarioId }),
  simulation.shares,
);

simulationRouter.delete(
  '/scenarios/:id/shares/:membershipId',
  writeLimit,
  validate({ params: schema.scenarioShare }),
  simulation.revokeShare,
);

/* §5 — what changed between two runs of the same question, and whether that
   was the data or the graph. */
simulationRouter.get(
  '/runs/:id/compare',
  validate({ params: schema.runId, query: schema.compareRuns }),
  simulation.compare,
);
