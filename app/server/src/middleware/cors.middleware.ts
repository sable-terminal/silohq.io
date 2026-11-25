// CORS for the one listener a browser calls from another origin: the directory's login
// listener, called by the login page (spec 6.2). Only the configured origins are
// answered; a request from any other origin is refused outright, and a preflight from one
// is answered 403. Every answer is no-store and no-referrer, so an address typed into the
// page is never cached or forwarded.

import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors.util.ts';

export interface CorsPolicy {
  origins: ReadonlySet<string>;
  methods: string;
  headers: string;
}

/** The response headers, with CORS for an allowed origin. */
export function allowOrigins(policy: CorsPolicy): RequestHandler {
  return (req, res, next) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('vary', 'origin');
    const origin = req.headers.origin;
    if (origin !== undefined && policy.origins.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-methods', policy.methods);
      res.setHeader('access-control-allow-headers', policy.headers);
      res.setHeader('access-control-max-age', '600');
    }
    next();
  };
}

/** The answer to a preflight: 204 for an allowed origin, 403 for any other. */
export function preflight(policy: CorsPolicy): RequestHandler {
  return (req, res) => {
    res.status(req.headers.origin !== undefined && policy.origins.has(req.headers.origin) ? 204 : 403).end();
  };
}

/** A request from an origin that is not allowed. A request with no Origin is not a cross-site browser call. */
export function refuseOtherOrigins(policy: CorsPolicy, code: string): RequestHandler {
  return (req, _res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !policy.origins.has(origin)) {
      throw new AppError('forbidden', 'this origin may not call this endpoint', { code });
    }
    next();
  };
}
