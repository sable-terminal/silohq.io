// Who is signed in, on the browser-facing listeners.
//
// The public API (spec 60.3): the session from the cookie, resolved by the auth service
// as the person's activity (it refuses an unknown, revoked or expired one); an
// MFA-pending session reaches only the MFA routes (spec 55.4); a route that writes is refused
// while the organisation's writes are paused (spec 6.4; auth checks it with the session); then
// the rate limit per session. The browser can send any header it likes; none of them becomes identity.
//
// The staff console (spec 13.3): the staff session from its own cookie, resolved now, so a
// suspended or removed member of staff is signed out on their next request; then the rate
// limit per staff session.
//
// The token is kept either way: the public API ends the session a sign-in replaces, and
// the staff console's sign-out names it.

import type { RequestHandler } from 'express';
import type { StaffRoute } from '../contracts/admin-portal/staffApi.contract.ts';
import type { PublicRoute } from '../contracts/gateway/publicRoute.contract.ts';
import type { ServiceClient } from '../infra/serviceClient.infra.ts';
import type { Staff } from '../services/admin-portal/deps.service.ts';
import { sessionToken as sessionTokenSchema } from '../contracts/auth/session.contract.ts';
import { requireComplete, resolveEdgePrincipal, resolveEdgeSession, sessionRequired } from '../services/gateway/forwarding.service.ts';
import { AppError } from '../utils/errors.util.ts';
import { sessionTokenOf, staffTokenOf } from './cookies.middleware.ts';
import type { RequestLimiter } from './rateLimit.middleware.ts';
import { localsOf } from './request.middleware.ts';

/** The token of an Authorization: Bearer header, if there is one. */
function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  if (!sessionTokenSchema.safeParse(token).success) {
    throw new AppError('unauthenticated', 'the access token is not valid; exchange the client secret again', { code: 'auth.session_invalid' });
  }
  return token;
}

/**
 * principals: whether an API client may call the route (a complete session's route that
 * names a permission or lets the forwarded service decide); never a person's own records
 * or session routes. writes: the route writes in the organisation (PublicRoute.writes).
 */
export function edgeSession(need: PublicRoute['session'], services: ServiceClient, limiter: RequestLimiter,
  options: { principals?: boolean; writes?: boolean } = {})
  : RequestHandler {
  return async (req, res, next) => {
    const locals = localsOf(res);
    const bearer = need === 'none' ? undefined : bearerOf(req.headers.authorization);
    if (bearer !== undefined) {
      if (need !== 'complete' || options.principals !== true) {
        throw new AppError('forbidden', 'an API client cannot use this route: it acts for a signed-in person', { code: 'gateway.member_required' });
      }
      const principal = await resolveEdgePrincipal(services, bearer, { correlationId: locals.correlationId, writes: options.writes === true });
      await limiter.perSession(principal.sessionId);
      await limiter.perOrganisation(principal.organisationId);
      locals.principal = principal;
      locals.log = locals.log.child({ organisationId: principal.organisationId, sessionId: principal.sessionId });
      next();
      return;
    }
    const token = sessionTokenOf(req.headers.cookie);
    if (token !== undefined) locals.token = token;
    if (need !== 'none') {
      if (token === undefined) throw sessionRequired();
      const session = await resolveEdgeSession(services, token, 'http_request', { correlationId: locals.correlationId, writes: options.writes === true });
      if (need === 'complete') requireComplete(session);
      await limiter.perSession(session.sessionId);
      await limiter.perOrganisation(session.organisationId);
      locals.session = session;
      locals.log = locals.log.child({ organisationId: session.organisationId, membershipId: session.membershipId, sessionId: session.sessionId });
    }
    next();
  };
}

export function staffSession(access: StaffRoute['access'], resolve: (token: string | undefined) => Promise<Staff>, limiter: RequestLimiter)
  : RequestHandler {
  return async (req, res, next) => {
    const locals = localsOf(res);
    const token = staffTokenOf(req.headers.cookie);
    if (token !== undefined) locals.token = token;
    if (access.kind !== 'public') {
      const staff = await resolve(token);
      await limiter.perSession(staff.sessionKey);
      locals.staff = staff;
      locals.log = locals.log.child({ resourceType: 'operator', resourceId: staff.operator.id });
    }
    next();
  };
}
