// Whether the signed-in caller may use the route, decided after the input is valid
// because a decision can depend on it (the scope or resource it names).
// - The public API (spec 57.1): the route's permission, decided by the policy service;
//   deny wins.
// - The staff console (spec 13.3): the route's staff capability, from the groups the staff
//   identity provider gave the member of staff at sign-in.

import type { RequestHandler } from 'express';
import type { StaffCapability } from '../contracts/admin-portal/capability.contract.ts';
import type { StaffRoute } from '../contracts/admin-portal/staffApi.contract.ts';
import type { PublicRoute } from '../contracts/gateway/publicRoute.contract.ts';
import type { ServiceClient } from '../infra/serviceClient.infra.ts';
import { authoriseRoute } from '../services/gateway/forwarding.service.ts';
import { AppError } from '../utils/errors.util.ts';
import { localsOf } from './request.middleware.ts';

export function routePermission(route: PublicRoute, services: ServiceClient): RequestHandler {
  return async (_req, res, next) => {
    const locals = localsOf(res);
    const actor = locals.session ?? locals.principal;
    if (actor !== undefined) await authoriseRoute(services, route, locals.input, actor, { correlationId: locals.correlationId });
    next();
  };
}

/** The capabilities a staff route needs, any one of which will do; none for a sign-in step or a route open to all staff. */
export function capabilitiesNeeded(route: StaffRoute, input: { params: unknown; query: unknown; body: unknown }): readonly StaffCapability[] {
  const access = route.access;
  if (access.kind === 'capability') return access.anyOf;
  if (access.kind === 'capability_of_input') return [access.of(input as never)];
  return [];
}

export function staffCapability(route: StaffRoute): RequestHandler {
  return (_req, res, next) => {
    const { staff, input } = localsOf(res);
    const needed = capabilitiesNeeded(route, input);
    if (staff !== undefined && needed.length > 0 && !needed.some((c) => staff.capabilities.has(c))) {
      throw new AppError('forbidden', `this needs the staff capability ${needed.join(' or ')}`, {
        code: 'staff.not_permitted', details: { capability: needed.join(',') },
      });
    }
    next();
  };
}
