import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { withTransaction } from '../infra/db.infra';
import { assertCan, authorityOf, type Authority } from '../services/authorisation.service';
import type { Actor } from '../services/scope.service';
import { denial, unauthenticated } from '../utils/error.util';

/**
 * The permission gate at the edge.
 *
 * IT IS A SECOND GATE, NOT THE ONLY ONE. `scope.service` and `role.service`
 * check again inside their transaction, at the scope the operation actually
 * touches, and those checks are the ones that matter — they are the ones a cron
 * or a worker calling the same service also gets. This one exists to fail early
 * and to make the routing table readable: `requirePermission('scope.create')`
 * next to a route says what the endpoint is for, and a reviewer can audit the
 * whole surface by reading one file.
 *
 * REMOVING THIS MIDDLEWARE MUST NOT OPEN AN ENDPOINT. Where a service does not
 * check for itself — members, invitations — this is the only gate, and those
 * routes are marked in the router. Anywhere else, deleting it costs a good error
 * message and nothing more.
 */

/** Load the authority once and keep it on the request. */
export async function authorityFor(req: Request): Promise<Authority> {
  if (req.authority) return req.authority;

  const auth = req.auth;
  if (!auth) throw unauthenticated();

  const authority = await withTransaction((db) =>
    authorityOf(db, auth.membership.id, auth.organisation.id),
  );

  req.authority = authority;
  return authority;
}

/** The actor `scope.service` and `role.service` take. */
export function actorOf(req: Request): Actor {
  const auth = req.auth;
  if (!auth) throw unauthenticated();
  return { organisationId: auth.organisation.id, membershipId: auth.membership.id };
}

/**
 * Require every one of these permissions, organisation-wide.
 *
 * NOT SCOPE-AWARE, DELIBERATELY. Whether you may create a scope *under this
 * parent* depends on the parent, which the service reads inside its transaction;
 * checking it here would mean reading the tree twice and letting the two
 * readings disagree. This asks the coarser question — do you hold this
 * permission anywhere — and the service asks the precise one.
 */
export function requirePermission(...permissions: string[]): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const authority = await authorityFor(req);
      for (const permission of permissions) assertCan(authority, permission);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Super admin only.
 *
 * FOR THE OPERATIONS WITH NO PERMISSION OF THEIR OWN because granting them would
 * be granting everything: creating a top-level scope, defining a marking, seeing
 * what a departed administrator left behind. A permission for these would be a
 * permission that is equivalent to the tier, and one that could be delegated.
 */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction): void {
  authorityFor(req)
    .then((authority) => {
      if (!authority.isSuperAdmin) {
        next(
          denial({
            message: 'Only a super administrator can do this.',
            code: 'denial.super_admin_required',
          }),
        );
        return;
      }
      next();
    })
    .catch(next);
}

/**
 * Refuse what the billing state has switched off.
 *
 * PAST DUE IS NOT SUSPENDED. A tenant behind on payment keeps reading and loses
 * writes; a suspended one loses both. Encoding that here rather than in each
 * handler means the answer is the same everywhere, and `capabilitiesFor` stays
 * the single place the policy is written down.
 */
export function requireCapability(capability: 'canQuery' | 'canMutate' | 'canExport'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const capabilities = req.auth?.capabilities;
    if (!capabilities) {
      next(unauthenticated());
      return;
    }

    if (!capabilities[capability]) {
      next(
        denial({
          message: capabilities.banner ?? 'This is unavailable on your current plan.',
          code: `denial.billing_${capability}`,
        }),
      );
      return;
    }

    next();
  };
}
