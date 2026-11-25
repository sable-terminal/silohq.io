import { Router } from 'express';
import * as role from '../controllers/role.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission, requireSuperAdmin } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/role.schema';
import { z } from 'zod';
import { uuid } from '../utils/schemas.util';

export const roleRouter: Router = Router();

roleRouter.use(requireAuth);

/**
 * THE CATALOGUE IS OPEN AND THE GRANTS ARE NOT. Any member may read which roles
 * and permissions exist, because that is what lets an interface explain a
 * refusal — "you need `mutation.approve`" is only useful if the reader can look
 * the name up. Who holds what is a different question and is not answered here.
 */
roleRouter.get('/', role.listRoles);
roleRouter.get('/permissions', role.listPermissions);

roleRouter.post(
  '/grants',
  writeLimit,
  requirePermission('role.grant'),
  validate({ body: schema.grantRole }),
  role.grant,
);

/*
 * A SEPARATE ROUTE RATHER THAN A FLAG ON THE ONE ABOVE. The rules genuinely
 * differ — a principal cannot be granted organisation-wide — and a shared
 * endpoint would need a branch that quietly rejects half its own schema.
 */
roleRouter.post(
  '/grants/principals',
  writeLimit,
  requirePermission('role.grant'),
  validate({ body: schema.grantToPrincipal }),
  role.grantPrincipal,
);

roleRouter.delete(
  '/grants/:assignmentId',
  writeLimit,
  requirePermission('role.grant'),
  validate({ params: schema.assignmentParams }),
  role.revoke,
);

/**
 * SUPER ADMIN, BECAUSE THE ANSWER IS AN ORGANISATION-WIDE LIST. A departing
 * administrator's grants can be anywhere in the tree, so this necessarily
 * reaches outside any one subtree — which means no scoped administrator can be
 * shown it without being shown grants they have no authority over.
 */
roleRouter.get(
  '/grants/orphaned/:membershipId',
  requireSuperAdmin,
  validate({ params: z.object({ membershipId: uuid }).strict() }),
  role.orphanedGrants,
);

/* ── Markings and clearances ────────────────────────────────────────────── */

export const markingRouter: Router = Router();

markingRouter.use(requireAuth);

markingRouter.get('/', role.listMarkings);

/**
 * DEFINING A MARKING IS SUPER ADMIN AND CANNOT BE DELEGATED. A marking is the
 * only construct that withholds something from a permission holder — it is the
 * mandatory gate sitting behind the discretionary one. A scoped administrator who
 * could define markings could put a resource beyond the reach of the super admin
 * who granted them their authority.
 */
markingRouter.post(
  '/',
  writeLimit,
  requireSuperAdmin,
  validate({ body: schema.createMarking }),
  role.createMarking,
);

markingRouter.post(
  '/clearances',
  writeLimit,
  requirePermission('clearance.grant'),
  validate({ body: schema.grantClearance }),
  role.grantClearance,
);

markingRouter.delete(
  '/clearances/:membershipId/:markingId',
  writeLimit,
  requirePermission('clearance.grant'),
  validate({ params: schema.clearanceParams }),
  role.revokeClearance,
);
