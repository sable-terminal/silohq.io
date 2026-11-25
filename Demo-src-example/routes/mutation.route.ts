import { Router } from 'express';
import * as mutation from '../controllers/mutation.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/mutation.schema';

/**
 * Mutations — the governed write path.
 *
 * MOUNTED IN EVERY BUILD. Changing a connected system is not storage: a
 * sovereign deployment writes to its own systems through exactly this path, and
 * the prior state and preview it keeps are bounded by the schema whatever the
 * storage switch says.
 *
 * PERMISSIONS ARE THE SERVICE'S. Who may see a preview depends on who proposed
 * it and which connections it names, which is only known once it is read.
 */
export const mutationRouter: Router = Router();

mutationRouter.use(requireAuth);

/*
 * PROPOSING READS EVERY SYSTEM THE CONCEPT SPANS, so it is rate limited like a
 * write although it writes nothing to them.
 */
mutationRouter.post('/', writeLimit, validate({ body: schema.proposeMutation }), mutation.propose);

/*
 * §3 — THE SAME CHANGE, IN WORDS. Compiled against what this person may change,
 * then proposed through the route above's service. Before `/:id`, like every
 * fixed path here.
 */
mutationRouter.post('/compile', writeLimit, validate({ body: schema.compileChange }), mutation.compile);

/*
 * ── Policy ───────────────────────────────────────────────────────────────────
 *
 * BEFORE `/:id`, which would otherwise take `policies` for an id and refuse it.
 * Who may set each is the connection's policy authority, decided in the service.
 */
mutationRouter.get('/policies', mutation.policies);

/*
 * HOW LONG RECEIPTS ARE KEPT. Shortening it ends every older receipt at once,
 * so it is `mutation.purge`'s, decided in the service.
 */
mutationRouter.get('/retention', mutation.retentionOf);
mutationRouter.put('/retention', writeLimit, validate({ body: schema.setRetention }), mutation.setRetention);

mutationRouter.put(
  '/policies/default',
  writeLimit,
  validate({ body: schema.setDefaultPolicy }),
  mutation.setDefaultPolicy,
);
mutationRouter.delete('/policies/default', writeLimit, mutation.removeDefaultPolicy);

mutationRouter.put(
  '/policies/connections/:connectionId',
  writeLimit,
  validate({ params: schema.connectionParams, body: schema.setPolicy }),
  mutation.setConnectionPolicy,
);
mutationRouter.delete(
  '/policies/connections/:connectionId',
  writeLimit,
  validate({ params: schema.connectionParams, query: schema.policyScope }),
  mutation.removeConnectionPolicy,
);

mutationRouter.put(
  '/policies/connections/:connectionId/floor',
  writeLimit,
  validate({ params: schema.connectionParams, body: schema.setFloor }),
  mutation.setFloor,
);
mutationRouter.delete(
  '/policies/connections/:connectionId/floor',
  writeLimit,
  validate({ params: schema.connectionParams }),
  mutation.removeFloor,
);

mutationRouter.put(
  '/policies/connections/:connectionId/authority',
  writeLimit,
  validate({ params: schema.connectionParams, body: schema.setAuthority }),
  mutation.setAuthority,
);

mutationRouter.get('/', validate({ query: schema.listMutations }), mutation.list);

mutationRouter.get('/:id', validate({ params: schema.mutationId }), mutation.read);

mutationRouter.get(
  '/:id/changes',
  validate({ params: schema.mutationId, query: schema.changesPage }),
  mutation.changes,
);

/* ── Approval ─────────────────────────────────────────────────────────────── */

mutationRouter.post('/:id/submit', writeLimit, validate({ params: schema.mutationId }), mutation.submit);

mutationRouter.post(
  '/:id/approve',
  writeLimit,
  validate({ params: schema.mutationId, body: schema.approveMutation }),
  mutation.approve,
);

mutationRouter.post(
  '/:id/reject',
  writeLimit,
  validate({ params: schema.mutationId, body: schema.rejectMutation }),
  mutation.reject,
);

/* ── Running ──────────────────────────────────────────────────────────────── */

/*
 * 202: THE CHANGE IS CLAIMED AND QUEUED, NOT FINISHED. Its status and receipt
 * say when it is.
 */
mutationRouter.post('/:id/execute', writeLimit, validate({ params: schema.mutationId }), mutation.execute);

mutationRouter.post('/:id/canary/confirm', writeLimit, validate({ params: schema.mutationId }), mutation.confirmCanary);

mutationRouter.post('/:id/canary/halt', writeLimit, validate({ params: schema.mutationId }), mutation.haltCanary);

mutationRouter.get('/:id/receipt', validate({ params: schema.mutationId }), mutation.receipt);

/* ── Reverting ────────────────────────────────────────────────────────────── */

/*
 * GET READS EVERY RECORD THE CHANGE WROTE and stores nothing: what would revert,
 * what is already back, and what somebody has changed since. POST asks for the
 * revert, which is a change of its own from there on.
 */
mutationRouter.get('/:id/revert', validate({ params: schema.mutationId }), mutation.inspectRevert);

mutationRouter.post(
  '/:id/revert',
  writeLimit,
  validate({ params: schema.mutationId, body: schema.requestRevert }),
  mutation.requestRevert,
);

/* ── Deleting a receipt ───────────────────────────────────────────────────── */

/* 202 where the organisation requires a second person: the request is pending, nothing is deleted yet. */
mutationRouter.post('/:id/purge', writeLimit, validate({ params: schema.mutationId }), mutation.purge);
