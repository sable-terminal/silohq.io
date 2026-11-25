// The staff console's HTTP API (contracts/admin-portal/staffApi) on the portal's own
// listener, apart from the customer gateway. Every request passes, in order (src/middleware):
// 1. a new correlation id, echoed back, and the gateway's security headers;
// 2. the gateway's cross-site defences against the portal's own origin;
// 3. the rate limit per client address;
// 4. unless the route is a sign-in step, the staff session from its cookie, resolved now
//    (a suspended or removed member of staff is signed out here), the rate limit per
//    session, and the route's capability;
// 5. the body (JSON only, bounded) and its validation against the route's schemas;
// 6. the route's handler, then the reply validated against its response schema, with the
//    session cookie set at sign-in and cleared at sign-out or when it names no session.
// Responses are never cached and never framed.

import type { Express, RequestHandler } from 'express';
import type { AdminPortalConfig } from '../../config/adminPortal.config.ts';
import type { StaffRoute } from '../../contracts/admin-portal/staffApi.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { staffCapability } from '../../middleware/authorise.middleware.ts';
import { jsonBody } from '../../middleware/body.middleware.ts';
import { clearedStaffCookie, readCookie, STAFF_COOKIE, staffCookie } from '../../middleware/cookies.middleware.ts';
import { jsonOnly, refusePreflight, sameSite } from '../../middleware/crossSite.middleware.ts';
import { errorHandler, notFound } from '../../middleware/errors.middleware.ts';
import { limitPerAddress, type StaffLimiter } from '../../middleware/rateLimit.middleware.ts';
import { correlation, createApp, localsOf, requestLog } from '../../middleware/request.middleware.ts';
import { securityHeaders } from '../../middleware/securityHeaders.middleware.ts';
import { staffSession } from '../../middleware/session.middleware.ts';
import { checkedReply, validateRequest } from '../../middleware/validate.middleware.ts';
import type { Staff } from '../../services/admin-portal/deps.service.ts';
import type { StaffAuth } from '../../services/admin-portal/staffAuth.service.ts';
import { isAppError } from '../../utils/errors.util.ts';

export interface StaffRequestContext {
  /** Absent on the sign-in routes only. */
  staff: Staff | undefined;
  correlationId: string;
  /** The session token from the cookie, for sign-out. */
  token: string | undefined;
}

/** What a route's handler returns; a sign-in also hands back the session it established. */
export type StaffHandlerResult = unknown | { established: { token: string; absoluteExpiresAt: string }; body: unknown };

export type StaffHandler = (input: { params: any; query: any; body: any }, ctx: StaffRequestContext) => Promise<StaffHandlerResult>;

export interface StaffAppDeps {
  config: AdminPortalConfig;
  publicOrigin: string;
  trustProxyHops: number;
  maxBodyBytes: number;
  logger: Logger;
  auth: StaffAuth;
  limiter: StaffLimiter;
  routes: readonly StaffRoute[];
  handlers: Readonly<Record<string, StaffHandler>>;
}

/** Step 6: the route's handler, and the reply with the session cookie set or cleared. */
function respond(route: StaffRoute, handler: StaffHandler): RequestHandler {
  return async (_req, res) => {
    const locals = localsOf(res);
    const result = await handler(locals.input, { staff: locals.staff, correlationId: locals.correlationId, token: locals.token });
    const established = route.session === 'establishes'
      ? (result as { established: { token: string; absoluteExpiresAt: string }; body: unknown }) : undefined;
    if (route.status === 204) {
      if (route.session === 'ends') res.append('set-cookie', clearedStaffCookie());
      res.status(204).end();
      return;
    }
    const reply = checkedReply(route.response, established === undefined ? result : established.body, locals.log, 'a staff response');
    if (established !== undefined) res.append('set-cookie', staffCookie(established.established.token, established.established.absoluteExpiresAt));
    if (route.session === 'ends') res.append('set-cookie', clearedStaffCookie());
    res.status(route.status).json(reply);
  };
}

export function createStaffApp(deps: StaffAppDeps): Express {
  const { logger, auth, limiter } = deps;
  for (const route of deps.routes) {
    if (deps.handlers[route.name] === undefined) throw new Error(`the staff route ${route.name} has no handler`);
  }
  const app = createApp();
  app.use(correlation({ trustCaller: false }), securityHeaders(), refusePreflight());

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  for (const route of deps.routes) {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const id = `admin-portal.${route.name}`;
    app[method](route.path,
      requestLog(logger, { id, method: route.method, event: 'admin_portal.request', message: 'staff request' }),
      sameSite(deps.publicOrigin),
      limitPerAddress(limiter, deps.trustProxyHops),
      staffSession(route.access, (token) => auth.resolve(token), limiter),
      jsonOnly(),
      jsonBody(Math.min(route.maxBodyBytes, deps.maxBodyBytes)),
      validateRequest(route, { emptyObjectIsNoBody: true }),
      staffCapability(route),
      respond(route, deps.handlers[route.name]!));
  }

  app.use(notFound(), errorHandler({
    logger, audience: 'public', event: 'admin_portal.failed', message: 'staff request failed',
    // A cookie that names no live staff session is cleared, so the browser stops sending it.
    beforeReply: (error, req, res) => {
      const invalid = isAppError(error) && ['staff.session_required', 'staff.session_revoked'].includes(error.code);
      if (invalid && readCookie(req.headers.cookie, STAFF_COOKIE) !== undefined) res.append('set-cookie', clearedStaffCookie());
    },
  }));
  return app;
}
