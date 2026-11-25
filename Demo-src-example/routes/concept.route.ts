import { Router } from 'express';
import * as concept from '../controllers/concept.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/concept.schema';
import { z } from 'zod';

export const conceptRouter: Router = Router();

conceptRouter.use(requireAuth);

/*
 * READING THE LIST NEEDS NO PERMISSION BEYOND MEMBERSHIP, and confirming needs
 * `concept.confirm`. Knowing which concepts exist is knowing the vocabulary of
 * your own organisation; what each one can actually resolve is already bounded
 * by the connections the reader holds, which the service applies per reader.
 */
conceptRouter.get('/', concept.list);

/*
 * The permission is checked in the service rather than here, because it is
 * `scopeable` and the answer depends on the connections named in the body —
 * which middleware cannot see.
 */
conceptRouter.post(
  '/',
  writeLimit,
  validate({ body: schema.confirmConcept }),
  concept.confirm,
);

/*
 * DERIVATION IS RATE LIMITED LIKE A WRITE because it behaves like one twice
 * over: it fans out to every reachable system to sample identifiers, and it
 * writes the queue a person then has to review. The permission is checked in
 * the service for the same reason confirmation's is — `concept.confirm` is
 * scopeable, and which connections it covers is not knowable from the route.
 */
conceptRouter.post(
  '/derive',
  writeLimit,
  validate({ body: schema.runDerivation }),
  concept.derive,
);

/*
 * LOOKING ACROSS SYSTEMS, WHEN ONE HAS JUST ARRIVED (133). Asked for in the
 * background by the page that confirmed a connection. No permission beyond
 * membership: it reads only what the caller can read, it does nothing unless a
 * connection is waiting, and whoever asks first is the only one who looks — so
 * it cannot be used to make Silo read a customer's systems over and over.
 */
conceptRouter.post('/join', writeLimit, concept.join);

conceptRouter.get('/proposals', concept.proposals);

conceptRouter.post(
  '/proposals/:id/reject',
  writeLimit,
  validate({ params: z.object({ id: z.string().uuid() }).strict() }),
  concept.reject,
);

/*
 * ── The concept view ───────────────────────────────────────────────────────
 *
 * PERMISSIONS ARE CHECKED IN THE SERVICE, not here, and for the reason the
 * confirm route already gives: `concept.confirm` is scopeable and which
 * connections it covers is not knowable from a URL. Reading is bounded by the
 * connections the reader holds, which the service applies per reader.
 */
const conceptId = z.object({ id: z.string().uuid() }).strict();

/*
 * §4.1 — the relationships between concepts.
 *
 * REGISTERED BEFORE `/:id`, AND THAT IS LOAD-BEARING RATHER THAN TIDINESS.
 * Express matches in order, so a `/relationships` declared after it is read as
 * a concept whose id is the word "relationships" — which fails the uuid
 * validator and answers 400 for a route that exists.
 *
 * NO PERMISSION BEYOND MEMBERSHIP, like the concept list it belongs beside.
 * What an edge can actually reveal is bounded by clearance, and the service
 * drops any edge whose either end the reader is not cleared for.
 */
conceptRouter.get('/relationships', concept.relationships);

conceptRouter.get('/:id', validate({ params: conceptId }), concept.read);

conceptRouter.get('/:id/revisions', validate({ params: conceptId }), concept.revisions);

conceptRouter.patch(
  '/:id',
  writeLimit,
  validate({ params: conceptId, body: schema.renameConcept }),
  concept.rename,
);

conceptRouter.put(
  '/:id/objects',
  writeLimit,
  validate({ params: conceptId, body: schema.correctConcept }),
  concept.correct,
);

conceptRouter.delete(
  '/:id',
  writeLimit,
  validate({ params: conceptId, body: schema.retireConcept }),
  concept.retire,
);

/*
 * §2.5 — MARKINGS ARE READ BY ANYONE WHO CAN SEE THE CONCEPT AND SET BY
 * `marking.apply`. Knowing a concept is restricted is not itself a disclosure;
 * deciding what is restricted is an organisation-wide act, and the service
 * holds that check because the permission is not scopeable.
 */
conceptRouter.get('/:id/markings', validate({ params: conceptId }), concept.markings);

conceptRouter.put(
  '/:id/markings',
  writeLimit,
  validate({ params: conceptId, body: schema.setConceptMarkings }),
  concept.setMarkings,
);

/*
 * §4.1 — WALKING A RELATIONSHIP.
 *
 * A POST BECAUSE IT CARRIES IDENTIFIERS, not because it changes anything. Up to
 * five hundred entity references do not belong in a query string, where they
 * would land in access logs and proxy caches — and §3.2's line holds whether a
 * reference is a value or not.
 *
 * RATE LIMITED LIKE A WRITE, for the reason derivation is: it fans out to a
 * customer's own system once per hop, and a walk is the cheapest way in this
 * product to ask an ERP a question several times in a row.
 *
 * THE PERMISSIONS ARE THE SERVICE'S. It checks clearance on BOTH concepts and
 * reachability on the connection the route runs in — none of which is knowable
 * from the route, because which system a walk touches depends on which route
 * was chosen.
 */
conceptRouter.post(
  '/walk',
  writeLimit,
  validate({ body: schema.walkConcepts }),
  concept.walk,
);

/*
 * §2.6 — RESOLVING A CONCEPT.
 *
 * A POST THAT WRITES NOTHING, AND RATE LIMITED LIKE A WRITE, for the reason
 * derivation gives above: it fans out to every system the concept spans and
 * pulls up to five thousand rows from each. That is a real cost to somebody's
 * production database, and it should not be repeatable by holding a key down.
 *
 * THE PERMISSIONS ARE THE SERVICE'S. It checks clearance on the concept and
 * reachability on every connection the concept spans — neither of which is
 * knowable from the route, because both depend on what the concept contains.
 */
conceptRouter.post(
  '/:id/resolve',
  writeLimit,
  validate({ params: conceptId, body: schema.resolveConcept }),
  concept.resolve,
);

/*
 * §7 — ASKING A CONCEPT A QUESTION.
 *
 * A POST THAT WRITES NOTHING, rate limited like a write for the reason
 * derivation and resolution are: it fans out to every system the concept spans
 * and pulls rows from each, which is a real cost to somebody's production
 * database.
 *
 * THE PERMISSION IS THE SERVICE'S. `query.run`, plus clearance on the concept
 * and reachability on every system it spans — none of which is knowable from
 * the route, because all of it depends on what the concept contains.
 */
conceptRouter.post(
  '/:id/ask',
  writeLimit,
  validate({ params: conceptId, body: schema.askConcept }),
  concept.ask,
);
