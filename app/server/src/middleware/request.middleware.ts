// What every request pipeline shares: the Express settings of each listener, the state a
// request carries from step to step (res.locals, read through localsOf), and the first
// steps of every pipeline, the correlation id and the request's one log line.
//
// The pipelines that use these steps:
// - the service listener (src/process.ts): services calling services over mTLS;
// - the public API (controllers/gateway/edge.controller.ts): the browser's JSON API;
// - the staff console (controllers/admin-portal/staff.controller.ts);
// - the directory's login listener (workers/directory/publicListener.worker.ts).

import express, { type RequestHandler, type Response } from 'express';
import type { Staff } from '../services/admin-portal/deps.service.ts';
import { CORRELATION_HEADER } from '../contracts/endpoint.contract.ts';
import type { EdgeClient, EdgePrincipal, EdgeSession } from '../contracts/gateway/publicRoute.contract.ts';
import type { ServiceName } from '../config/service.config.ts';
import type { Logger } from '../infra/logger.infra.ts';
import type { RequestContext } from '../infra/postgres.infra.ts';
import { recordOutcome } from '../infra/telemetry.infra.ts';
import { isUuid, uuidv7 } from '../utils/id.util.ts';

/** The state of one request, filled in by the steps it has passed. */
export interface RequestLocals {
  correlationId: string;
  /** Bound with the correlation id and route; later steps add the caller, session or staff member. */
  log: Logger;
  /** The error the request failed with, for the outcome metric. */
  failure: unknown;
  /** The params, query and body, validated against the route's schemas. */
  input: { params: any; query: any; body: any };
  /** Public listeners: the client's address and user agent. */
  client?: EdgeClient;
  /** Public listeners: the session token from the cookie, if it has the shape of one. */
  token?: string;
  /** The public API: the person's session, on a route that needs one. */
  session?: EdgeSession;
  /** The public API: an API client's access session, from its bearer token (spec 60.5). */
  principal?: EdgePrincipal;
  /** The staff console: the signed-in member of staff, on a route that needs one. */
  staff?: Staff;
  /** The service listener: the calling service and its cell, from its certificate. */
  caller?: ServiceName;
  callerCell?: string;
  /** The service listener: the organisation, user and actor the caller sent. */
  request?: RequestContext;
  /** The service listener: the caller's Idempotency-Key. */
  idempotencyKey?: string;
  /** Aborts when the request times out or the caller goes away. */
  signal?: AbortSignal;
}

export const localsOf = (res: Response): RequestLocals => res.locals as RequestLocals;

/** An Express app with the settings every listener shares: no fingerprint, no ETags, a simple query parser. */
export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('query parser', 'simple');
  return app;
}

/**
 * A correlation id for the request, echoed back. Another service's id is kept when it is
 * a UUID, so one id follows a request through the cell; a browser's never is.
 */
export function correlation(options: { trustCaller: boolean }): RequestHandler {
  return (req, res, next) => {
    const given = req.headers[CORRELATION_HEADER];
    const id = options.trustCaller && typeof given === 'string' && isUuid(given) ? given : uuidv7();
    localsOf(res).correlationId = id;
    res.setHeader(CORRELATION_HEADER, id);
    next();
  };
}

/** One log line and one outcome per request, written when the response has been sent. */
export function requestLog(logger: Logger, route: { id: string; method: string; event: string; message: string }): RequestHandler {
  return (_req, res, next) => {
    const started = performance.now();
    const locals = localsOf(res);
    locals.log = logger.child({ correlationId: locals.correlationId, route: route.id, method: route.method });
    res.on('finish', () => {
      locals.log.info(route.message, { event: route.event, status: res.statusCode, durationMs: Math.round(performance.now() - started) });
      recordOutcome(route.id, locals.failure);
    });
    next();
  };
}
