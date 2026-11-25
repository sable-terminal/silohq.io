import { Router } from 'express';
import * as scope from '../controllers/scope.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/authenticate.middleware';
import { requirePermission, requireSuperAdmin } from '../middleware/authorise.middleware';
import { writeLimit } from '../middleware/rateLimit.middleware';
import * as schema from '../schemas/scope.schema';

/**
 * The tree, and who may reshape it.
 *
 * THE CHECKS HERE ARE THE COARSE HALF OF A PAIR. `scope.service` runs the precise
 * one inside its transaction — do you administer the parent, is the target
 * beneath a scope you administer, would this exceed the depth cap. These lines
 * say what the endpoint is for and fail fast; deleting one costs a good error and
 * nothing else.
 *
 * READING THE TREE NEEDS NO PERMISSION. Every member sees the structure of their
 * own organisation, because it is the vocabulary the whole interface is built on
 * — a scope picker that only showed the scopes you can administer would be empty
 * for almost everyone. What you may *do* in each is a separate question, asked
 * separately.
 */

export const scopeRouter: Router = Router();

scopeRouter.use(requireAuth);

scopeRouter.get('/types', scope.listTypes);
scopeRouter.get('/', scope.tree);

/**
 * DEFINING A TYPE IS A SUPER-ADMIN ACT. The types are the organisation's own
 * vocabulary — Department, Matter, Region — and they appear in every picker and
 * every report. Letting anyone who can create a scope also invent a type
 * produces four spellings of "Team" within a month, and no way to merge them.
 */
scopeRouter.post(
  '/types',
  writeLimit,
  requireSuperAdmin,
  validate({ body: schema.createScopeType }),
  scope.createType,
);

scopeRouter.post(
  '/',
  writeLimit,
  requirePermission('scope.create'),
  validate({ body: schema.createScope }),
  scope.create,
);

/**
 * MOVING IS ITS OWN PERMISSION BECAUSE IT IS NOT AN EDIT. Moving a scope moves
 * every scope beneath it, and with them every grant that was made at those
 * scopes — so one request can hand a subtree to a different administrator. The
 * service refuses a move that would take a scope outside the mover's own
 * subtree; this makes the operation nameable in an audit.
 */
scopeRouter.post(
  '/:scopeId/move',
  writeLimit,
  requirePermission('scope.move'),
  validate({ params: schema.scopeParams, body: schema.moveScope }),
  scope.move,
);

scopeRouter.delete(
  '/:scopeId',
  writeLimit,
  requirePermission('scope.archive'),
  validate({ params: schema.scopeParams }),
  scope.archive,
);

scopeRouter.post(
  '/:scopeId/members',
  writeLimit,
  requirePermission('scope.assign'),
  validate({ params: schema.scopeParams, body: schema.addScopeMember }),
  scope.addMember,
);

scopeRouter.delete(
  '/:scopeId/members/:membershipId',
  writeLimit,
  requirePermission('scope.assign'),
  validate({ params: schema.scopeMemberParams }),
  scope.removeMember,
);
