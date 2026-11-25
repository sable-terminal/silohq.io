// The public HTTP API (spec 7.3): the routing table (contracts/gateway/routeTable) on
// Express. Every request passes, in order (src/middleware):
// 1. a new correlation id, echoed back, and the security headers;
// 2. cross-site defences;
// 3. the rate limit per client address;
// 4. for a route that needs one, the session from the cookie, resolved by the auth
//    service as the person's activity; an MFA-pending session reaches only the MFA
//    routes; then the rate limit per session;
// 5. the body (JSON only, bounded) and its validation against the route's schemas;
// 6. the route's permission, decided by the policy service;
// 7. the forward to the internal contract, context from the session alone;
// 8. the reply, validated against the route's response schema, with the cookie set when
//    a session was established and cleared when one ended or was found invalid.
// Responses are never cached (Cache-Control: no-store; spec 30.7) and never framed.
//
// A webhook route (a provider's server, never a browser) skips steps 2 and 4 and the
// JSON rule of step 5: a request carrying browser fetch metadata is refused, the body is
// read as raw bytes and must be UTF-8, and it is forwarded unparsed with the signature
// header verbatim, for the receiving service to verify.

import type { Express, RequestHandler } from 'express';
import type { Config } from '../../config/index.config.ts';
import { IDEMPOTENCY_HEADER } from '../../contracts/endpoint.contract.ts';
import type { EdgeContext, PublicRoute } from '../../contracts/gateway/publicRoute.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { routePermission } from '../../middleware/authorise.middleware.ts';
import { jsonBody, signedBody } from '../../middleware/body.middleware.ts';
import { clearedSessionCookie, sessionCookie } from '../../middleware/cookies.middleware.ts';
import { apiClientOnly, jsonOnly, notBrowser, refusePreflight, sameSiteOrClient } from '../../middleware/crossSite.middleware.ts';
import { errorHandler, notFound } from '../../middleware/errors.middleware.ts';
import { limitPerAddress, type EdgeLimiter } from '../../middleware/rateLimit.middleware.ts';
import { correlation, createApp, localsOf, requestLog } from '../../middleware/request.middleware.ts';
import { securityHeaders } from '../../middleware/securityHeaders.middleware.ts';
import { edgeSession } from '../../middleware/session.middleware.ts';
import { checkedReply, validateRequest } from '../../middleware/validate.middleware.ts';
import { endReplacedSession, forwardRoute } from '../../services/gateway/forwarding.service.ts';
import { answerFor, type WebClient } from '../../services/gateway/webClient.service.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { mountChangeHooks } from './changeHooks.controller.ts';
import { mountEmailHooks } from './emailHooks.controller.ts';
import { mountFederation } from './federation.controller.ts';

export interface EdgeDeps {
  config: Config;
  publicOrigin: string;
  logger: Logger;
  services: ServiceClient;
  limiter: EdgeLimiter;
  routes: readonly PublicRoute[];
  /** The web client's export, served at the public origin beside the API. */
  web?: WebClient | undefined;
}

/**
 * The web client's files (services/gateway/webClient): a GET or HEAD outside the API, from
 * the export loaded at start. Pages may be opened from anywhere (a link in an email), so the
 * API's cross-site rules do not apply; a page carries no data, and its policy allows only its
 * own scripts.
 */
function webClient(client: WebClient): RequestHandler {
  return (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path === '/api' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    // The path as sent: parsed as a URL, //host/... would name another host.
    const query = req.originalUrl.indexOf('?');
    const answer = answerFor(client, req.path, query === -1 ? '' : req.originalUrl.slice(query));
    if (answer === undefined) {
      next();
      return;
    }
    if (answer.kind === 'redirect') {
      res.setHeader('cache-control', 'no-cache');
      res.redirect(308, answer.location);
      return;
    }
    const { file, status } = answer;
    res.setHeader('content-type', file.contentType);
    res.setHeader('etag', file.etag);
    res.setHeader('cache-control', file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.setHeader('vary', 'accept-encoding');
    if (file.csp !== undefined) res.setHeader('content-security-policy', file.csp);
    if (status === 200 && req.headers['if-none-match'] === file.etag) {
      res.status(304).end();
      return;
    }
    const brotli = file.brotli !== undefined && /(^|[\s,])br(;|,|$)/.test(String(req.headers['accept-encoding'] ?? ''));
    const body = brotli ? file.brotli! : file.body;
    if (brotli) res.setHeader('content-encoding', 'br');
    res.setHeader('content-length', String(body.length));
    res.status(status);
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  };
}

/** Step 7 and 8: the forward to the internal contract, context from the session alone, and the reply. */
function forward(route: PublicRoute, services: ServiceClient): RequestHandler {
  return async (req, res) => {
    const locals = localsOf(res);
    const header = req.headers[IDEMPOTENCY_HEADER];
    const ctx: EdgeContext = { session: locals.session as never, principal: locals.principal, client: locals.client! };
    const forwarded = await forwardRoute(services, route, locals.input, ctx, {
      correlationId: locals.correlationId, idempotencyKey: typeof header === 'string' ? header : undefined,
    });
    const reply = checkedReply(route.response, forwarded.body, locals.log, 'a public response');
    if (forwarded.established !== undefined) {
      res.append('set-cookie', sessionCookie(forwarded.established.token, forwarded.established.absoluteExpiresAt));
      endReplacedSession(services, locals.token, forwarded.established.token, { correlationId: locals.correlationId });
    }
    if (route.ends) res.append('set-cookie', clearedSessionCookie());
    if (route.status === 204) res.status(204).end();
    else res.status(route.status).json(reply);
  };
}

export function createEdgeApp(deps: EdgeDeps): Express {
  const { config, logger, services, limiter } = deps;
  const app = createApp();
  app.use(correlation({ trustCaller: false }), securityHeaders(), refusePreflight());

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // The SAML assertion consumer and SCIM: not the browser's JSON API (federation.controller).
  mountFederation(app, deps);
  // Providers' change webhooks: raw body and headers to change-stream (changeHooks.controller).
  mountChangeHooks(app, deps);
  // Email fallback: messages the cell's mail relay forwards (emailHooks.controller).
  mountEmailHooks(app, deps);

  for (const route of deps.routes) {
    const contractLimit = route.forwards?.maxBodyBytes ?? config.http.maxBodyBytes;
    const limit = Math.min(route.maxBodyBytes ?? contractLimit, contractLimit, config.http.maxBodyBytes);
    const webhook = route.webhook;
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    app[method](route.path,
      requestLog(logger, { id: route.id, method: route.method, event: 'gateway.request', message: 'request' }),
      webhook !== undefined ? notBrowser() : route.apiClient ? apiClientOnly() : sameSiteOrClient(deps.publicOrigin),
      limitPerAddress(limiter, config.http.trustProxyHops),
      // An API client reaches only a complete session's route whose decision the policy service makes (spec 60.5, 60.6).
      edgeSession(route.session, services, limiter, {
        principals: route.permission !== undefined || route.decidedByService !== undefined, writes: route.writes,
      }),
      ...(webhook === undefined ? [jsonOnly(), jsonBody(limit)] : [signedBody(webhook, config.http.maxBodyBytes)]),
      validateRequest(route, { emptyObjectIsNoBody: webhook === undefined }),
      routePermission(route, services),
      forward(route, services));
  }

  if (deps.web !== undefined) app.use(webClient(deps.web));

  app.use(notFound(), errorHandler({
    logger, audience: 'public', event: 'gateway.failed', message: 'request failed',
    // A cookie that names no live session is cleared, so the browser stops sending it.
    beforeReply: (error, req, res) => {
      const invalid = isAppError(error) && (error.code === 'auth.session_invalid' || error.code === 'gateway.session_required');
      if (invalid && req.headers.cookie !== undefined) res.append('set-cookie', clearedSessionCookie());
    },
  }));
  return app;
}
