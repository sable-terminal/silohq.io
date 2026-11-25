import { Router } from 'express';
import * as graph from '../controllers/dependencyGraph.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/dependencyGraph.schema';

/**
 * Simulation §2 — the dependency graph.
 *
 * DERIVATION IS RATE LIMITED LIKE A WRITE because it is one: it reads the whole
 * ontology and writes a queue somebody then has to work through. The same
 * reasoning `/concepts/derive` carries.
 *
 * PERMISSIONS ARE CHECKED IN THE SERVICE, not here — `graph.propose` on
 * derivation and `graph.confirm` on the three verbs that change the live graph.
 * Reading the list and an edge's history is reading your own organisation's
 * account of what waits on what, which membership covers and the tenant policy
 * bounds.
 *
 * `PATCH` FOR A REVISION AND `DELETE` FOR A RETIREMENT, though neither replaces
 * nor removes anything: §2.3 keeps every prior state and §5 needs them. The
 * verbs describe what the caller means, and the row underneath is append-only
 * whatever they meant.
 */
export const dependencyGraphRouter: Router = Router();

dependencyGraphRouter.use(requireAuth);

dependencyGraphRouter.get('/edges', graph.list);

dependencyGraphRouter.post('/edges/derive', writeLimit, graph.derive);

/*
 * §2.2 — lead times from history. Rate limited like derivation and for the same
 * two reasons: it reads every watched concept's transitions and it walks to
 * somebody's production systems once per measurable edge.
 */
dependencyGraphRouter.post('/edges/observe', writeLimit, graph.observe);

/* §2.2 — an edge a person asserts where no foreign key implies one. */
dependencyGraphRouter.post(
  '/edges',
  writeLimit,
  validate({ body: schema.stateEdge }),
  graph.state,
);

dependencyGraphRouter.get('/edges/:id/revisions', validate({ params: schema.edgeId }), graph.history);

dependencyGraphRouter.post(
  '/edges/:id/confirm',
  writeLimit,
  validate({ params: schema.edgeId, body: schema.edgeJudgement }),
  graph.confirm,
);

dependencyGraphRouter.patch(
  '/edges/:id',
  writeLimit,
  validate({ params: schema.edgeId, body: schema.reviseEdge }),
  graph.revise,
);

dependencyGraphRouter.delete(
  '/edges/:id',
  writeLimit,
  validate({ params: schema.edgeId, body: schema.retireEdge }),
  graph.retire,
);
