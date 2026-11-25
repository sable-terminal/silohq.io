// Cross-site request defences. The web client is served from the gateway's one public
// origin and there is no CORS beyond it, so a request from anywhere else is refused:
//
// - Fetch metadata: a browser marks every request with Sec-Fetch-Site; one marked
//   cross-site or same-site (a sibling subdomain) is refused whatever its method. The
//   API has no page a foreign site may load.
// - State-changing requests (every method but GET and HEAD) must carry an Origin equal
//   to the public origin and the x-silo-csrf header. Browsers send Origin on every such
//   request; the custom header cannot be added by a form, and adding it from a foreign
//   page needs a CORS preflight, which is never granted. A request body must be JSON,
//   which a form cannot send either.
// - WebSocket handshakes, which CORS does not cover at all, must carry the public origin
//   (cross-site WebSocket hijacking).
//
// Together with the SameSite=Strict session cookie these make a double-submit token
// unnecessary: there is no token to issue, store, rotate or leak into page script, and
// the same Origin rule covers the WebSocket handshake, which a token in a header could
// not (browsers cannot set headers on a WebSocket).

import type { IncomingHttpHeaders } from 'node:http';
import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors.util.ts';

export const CSRF_HEADER = 'x-silo-csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

const crossSiteRefusal = (detail: string): AppError =>
  new AppError('forbidden', `cross-site requests are refused: ${detail}`, { code: 'gateway.cross_site' });

export function checkCrossSite(method: string, headers: IncomingHttpHeaders, publicOrigin: string): void {
  const site = headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') throw crossSiteRefusal('the request came from another site');
  if (SAFE_METHODS.has(method)) return;
  if (headers.origin !== publicOrigin) throw crossSiteRefusal('the Origin is not this site');
  if (headers[CSRF_HEADER] === undefined) throw crossSiteRefusal(`send the ${CSRF_HEADER} header`);
}

export function checkWebSocketOrigin(headers: IncomingHttpHeaders, publicOrigin: string): void {
  if (headers.origin !== publicOrigin) throw crossSiteRefusal('the WebSocket Origin is not this site');
}

/**
 * A webhook comes from a provider's server: a request a browser marked as coming from a
 * page (every browser sends Sec-Fetch-Site) is refused. Sec-Fetch-Mode alone is not a
 * browser: server-side fetch implementations send it too.
 */
export function checkNotBrowser(headers: IncomingHttpHeaders): void {
  if (headers['sec-fetch-site'] !== undefined) throw crossSiteRefusal('a webhook is not sent by a browser');
}

/** A request with a body must send JSON. */
export function checkBodyType(headers: IncomingHttpHeaders): void {
  const length = headers['content-length'];
  const hasBody = headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
  if (!hasBody) return;
  const type = (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    throw new AppError('validation', 'the request body must be application/json', { code: 'request.content_type' });
  }
}

/** No CORS: a preflight is only ever sent cross-origin, and is refused. */
export function refusePreflight(): RequestHandler {
  return (req, _res, next) => {
    if (req.method === 'OPTIONS') throw new AppError('forbidden', 'cross-origin requests are refused', { code: 'gateway.cross_site' });
    next();
  };
}

/** A browser request from this listener's own page only. */
export function sameSite(publicOrigin: string): RequestHandler {
  return (req, _res, next) => {
    checkCrossSite(req.method, req.headers, publicOrigin);
    next();
  };
}

/**
 * A browser request from this listener's own page, or an API client's request with its
 * bearer token: the cookie defences (Origin, the custom header) are for cookies, which a
 * bearer request does not carry, and a browser cannot attach a bearer token cross-site.
 */
export function sameSiteOrClient(publicOrigin: string): RequestHandler {
  return (req, _res, next) => {
    if (isBearer(req.headers)) checkApiClient(req.headers);
    else checkCrossSite(req.method, req.headers, publicOrigin);
    next();
  };
}

/** An API client's server, never a browser (the token exchange). */
export function apiClientOnly(): RequestHandler {
  return (req, _res, next) => {
    checkApiClient(req.headers);
    next();
  };
}

/** A provider's server, never a browser. */
export function notBrowser(): RequestHandler {
  return (req, _res, next) => {
    checkNotBrowser(req.headers);
    next();
  };
}

/** A request carrying a bearer token is an API client's (spec 60.5): never a browser, never with a cookie too. */
export function checkApiClient(headers: IncomingHttpHeaders): void {
  if (headers['sec-fetch-site'] !== undefined) throw crossSiteRefusal('an API client is not a browser');
  if ((headers.cookie ?? '').includes('silo_session=')) {
    throw new AppError('validation', 'send a session cookie or a bearer token, not both', { code: 'gateway.ambiguous_credentials' });
  }
}

const isBearer = (headers: IncomingHttpHeaders): boolean => (headers.authorization ?? '').startsWith('Bearer ');

/** A body, if there is one, must be JSON. */
export function jsonOnly(): RequestHandler {
  return (req, _res, next) => {
    checkBodyType(req.headers);
    next();
  };
}
