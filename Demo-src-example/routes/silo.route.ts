import { Router } from 'express';
import { z } from 'zod';
import * as silo from '../controllers/silo.controller';
import * as file from '../controllers/file.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/silo.schema';

export const siloRouter: Router = Router();

siloRouter.use(requireAuth);

const siloId = z.object({ id: z.string().uuid() }).strict();

/*
 * SS10 -- THE MASTER SWITCH IS NOT ON A SILO, IT IS ON THE ORGANISATION, and it
 * is `silo.enable`: super admin only, and not delegable to a scope admin. A
 * scope administrator can do a great deal within their scope; deciding that the
 * organisation now stores customer data is not one of those things.
 */
siloRouter.get('/storage', silo.storage);

siloRouter.put('/storage', writeLimit, validate({ body: schema.setStorage }), silo.setStorage);

siloRouter.get('/', silo.list);

siloRouter.post('/', writeLimit, validate({ body: schema.createSilo }), silo.create);

/*
 * ADDING A CONCEPT IS `silo.manage` PLUS A MARKING CHECK, and the marking check
 * is the part that is easy to leave out. Somebody holding `silo.manage` who
 * lacks clearance on a concept cannot add it: doing so would create a store of
 * data they cannot see.
 */
siloRouter.post(
  '/:id/concepts',
  writeLimit,
  validate({ params: siloId, body: schema.addConcept }),
  silo.addConcept,
);

siloRouter.get('/:id/candidates', validate({ params: siloId }), silo.candidates);

/*
 * SILOES (135) — CONCEPTS KEPT WHOLE, FOR VOLUME. A copy of every record of a
 * concept, made on a schedule, that its questions are answered from. Keeping,
 * copying and releasing are `silo.manage` and need storage switched on — both
 * checked in the service, where the concept's clearance is checked too.
 * Listing what is kept shows only that a copy exists, how large and how old.
 */
const keptConcept = z.object({ id: z.string().uuid(), conceptId: z.string().uuid() }).strict();

siloRouter.get('/:id/kept', validate({ params: siloId }), silo.kept);
siloRouter.post('/:id/kept', writeLimit, validate({ params: siloId, body: z.object({ conceptId: z.string().uuid(), history: z.boolean().optional() }).strict() }), silo.keep);
siloRouter.post('/:id/kept/:conceptId/sync', writeLimit, validate({ params: keptConcept }), silo.syncKept);
siloRouter.delete('/:id/kept/:conceptId', writeLimit, validate({ params: keptConcept }), silo.release);

/*
 * SILOES (139) — A SILO READ BY OTHER TOOLS. A Google identity a super admin
 * names may read a dataset of VIEWS of this Silo's kept concepts, and nothing
 * else. Naming one is `silo.enable` — the permission that switches storage on,
 * because it is the same weight of decision — and needs clearance for every
 * concept the Silo keeps; taking one off is `silo.manage`. All checked in the
 * service. Only where the Silo's copies are in BigQuery.
 */
const reader = z
  .object({
    kind: z.enum(['user', 'group', 'service_account']),
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

siloRouter.get('/:id/readers', validate({ params: siloId }), silo.readers);
siloRouter.post('/:id/readers', writeLimit, validate({ params: siloId, body: reader }), silo.grantReader);
siloRouter.delete(
  '/:id/readers/:readerId',
  writeLimit,
  validate({ params: z.object({ id: z.string().uuid(), readerId: z.string().uuid() }).strict() }),
  silo.revokeReader,
);

/*
 * Files §5 — the documents uploaded into this Silo.
 *
 * LISTED WHERE THEY ARE KEPT. Every upload requires a Silo, so a room of their
 * own was a second address for something that already has one; Exports holds
 * what Silo produced, and this holds what somebody put in. The handler is the
 * file service's, because §2 decides access on the file rather than the Silo.
 */
siloRouter.get('/:id/documents', validate({ params: siloId }), file.documentsOfSilo);

/*
 * SHORTENING A WINDOW REQUIRES `silo.purge`, NOT `silo.manage` -- decided in the
 * service, because only it knows the current window. Otherwise purge is
 * bypassed entirely by setting retention to a day and waiting.
 */
siloRouter.put(
  '/:id/retention',
  writeLimit,
  validate({ params: siloId, body: schema.setRetention }),
  silo.setRetention,
);

siloRouter.post(
  '/:id/purge',
  writeLimit,
  validate({ params: siloId, body: schema.purge }),
  silo.purge,
);

siloRouter.get('/:id/usage', validate({ params: siloId }), silo.usage);

/*
 * REMOVING A CONCEPT IS `silo.manage` AND DELETES NOTHING. It stops future
 * capture. Taking what is already held is `silo.purge`, one route down, and
 * keeping those apart is what stops "stop watching this" from quietly
 * destroying evidence.
 */
siloRouter.delete(
  '/:id/concepts/:conceptId',
  writeLimit,
  validate({ params: z.object({ id: z.string().uuid(), conceptId: z.string().uuid() }).strict() }),
  silo.removeConcept,
);

/*
 * §4 — CHANGING THE NOMINATED FIELDS IS `silo.manage`, under the same marking
 * and field checks as nominating the concept, because widening the list creates
 * more stored data. Narrowing deletes nothing.
 */
siloRouter.put(
  '/:id/concepts/:conceptId',
  writeLimit,
  validate({
    params: z.object({ id: z.string().uuid(), conceptId: z.string().uuid() }).strict(),
    body: schema.setFields,
  }),
  silo.setFields,
);

siloRouter.get('/:id/receipts', validate({ params: siloId }), silo.receipts);

siloRouter.get('/:id/disclosure', validate({ params: siloId }), silo.disclosure);

