import { Router } from 'express';
import * as member from '../controllers/member.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/member.schema';
import { z } from 'zod';
import { uuid } from '../utils/schemas.util';

/**
 * THE PERMISSION CHECKS ON THIS ROUTER ARE LOAD-BEARING, unlike those on the
 * scope and role routers. `member.service` and `invitation.service` take an
 * acting membership and act on it — they do not ask whether that membership was
 * allowed to. Deleting a `requirePermission` line here opens the endpoint to
 * every authenticated member of the organisation.
 *
 * That asymmetry is a wart and it is recorded rather than hidden: the eventual
 * fix is to move the checks into those two services, where a worker or a cron
 * calling them would get them too.
 */

export const memberRouter: Router = Router();

memberRouter.use(requireAuth);

memberRouter.get('/', validate({ query: schema.listMembers }), member.list);

/** Every member may read their own authority. It describes only themselves. */
memberRouter.get('/me/authority', member.authority);

memberRouter.post(
  '/:membershipId/suspend',
  writeLimit,
  requirePermission('member.suspend'),
  validate({ params: schema.memberParams }),
  member.suspend,
);

memberRouter.post(
  '/:membershipId/reinstate',
  writeLimit,
  requirePermission('member.suspend'),
  validate({ params: schema.memberParams }),
  member.reinstate,
);

/**
 * REMOVAL NEEDS ITS OWN PERMISSION, NOT `member.suspend`. Suspension is
 * reversible and frees nothing; removal frees the seat and ends the person's
 * access to everything the organisation holds. Somebody trusted to pause an
 * account is not automatically trusted to end one.
 */
memberRouter.delete(
  '/:membershipId',
  writeLimit,
  requirePermission('member.remove'),
  validate({ params: schema.memberParams }),
  member.remove,
);

/* ── Invitations ────────────────────────────────────────────────────────── */

export const invitationRouter: Router = Router();

invitationRouter.use(requireAuth);

invitationRouter.get('/', requirePermission('member.invite'), member.listInvitations);

invitationRouter.post(
  '/',
  writeLimit,
  requirePermission('member.invite'),
  validate({ body: schema.invite }),
  member.invite,
);

invitationRouter.delete(
  '/:invitationId',
  writeLimit,
  requirePermission('member.invite'),
  validate({ params: z.object({ invitationId: uuid }).strict() }),
  member.revokeInvitation,
);
