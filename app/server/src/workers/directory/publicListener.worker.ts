// The directory's public listener: the one endpoint the login page calls from the browser
// to find its cell (spec 6.2, "Login routing (browser to directory, then to the cell)").
// Apart from the service listener, which only admits services by mTLS.
//
// - POST /v1/login/route with a slug or an address; nothing else but /healthz.
// - JSON only, 1 KiB at most; no cookies are read or set; every answer is no-store and
//   no-referrer, so an address typed into the page is never cached or forwarded.
// - A browser may call it only from a configured login-page origin (CORS).
// - Per client address, a fixed window of DIRECTORY_PUBLIC_REQUESTS_PER_MINUTE in this
//   process. The global load balancer limits first; this is the floor. When the table of
//   addresses is full the listener sheds load rather than forget who it limited.
// - One log line per request: route, status, outcome, duration. Never the address, the
//   slug or the client address.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import type { GlobalTierConfig } from '../../config/globalTier.config.ts';
import {
  LOGIN_ROUTE_PATH, loginRouteRequest, loginRouteResponse, SIGNUP_PLACE_PATH, signupPlaceRequest, signupPlaceResponse,
} from '../../contracts/directory/registration.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Worker } from '../../infra/service.infra.ts';
import { jsonBody } from '../../middleware/body.middleware.ts';
import { allowOrigins, preflight, refuseOtherOrigins, type CorsPolicy } from '../../middleware/cors.middleware.ts';
import { errorHandler, notFound } from '../../middleware/errors.middleware.ts';
import { AddressRateLimit } from '../../middleware/rateLimit.middleware.ts';
import { createApp } from '../../middleware/request.middleware.ts';
import type { Directory } from '../../services/directory/directory.service.ts';
import { ContractViolation, isAppError } from '../../utils/errors.util.ts';

const MAX_BODY_BYTES = 1024;

export interface PublicListenerOptions {
  directory: Directory;
  config: GlobalTierConfig['directory'];
  /** Proxies in front of the listener to trust for the client address. */
  trustProxyHops: number;
  logger: Logger;
  /** Told the bound port once listening (tests bind port 0). */
  onListening?: (port: number) => void;
}

export function publicListener(options: PublicListenerOptions): Worker {
  const { config, logger } = options;
  const limit = new AddressRateLimit(config.publicRequestsPerMinute);
  const cors: CorsPolicy = { origins: new Set(config.publicOrigins), methods: 'POST', headers: 'content-type' };

  const app = createApp();
  app.set('trust proxy', options.trustProxyHops);
  app.use(allowOrigins(cors));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.options(LOGIN_ROUTE_PATH, preflight(cors));

  // One log line per request, never the address, the slug or the client address; its
  // outcome is the answer's next step or the error's code.
  app.post(LOGIN_ROUTE_PATH,
    (_req, res, next) => {
      const started = performance.now();
      res.on('finish', () => {
        logger.info('login route', {
          event: 'directory.login_route', route: LOGIN_ROUTE_PATH, status: res.statusCode,
          outcome: (res.locals['outcome'] as string | undefined) ?? 'error', durationMs: Math.round(performance.now() - started),
        });
      });
      next();
    },
    refuseOtherOrigins(cors, 'login.origin_refused'),
    (req, _res, next) => {
      limit.take(req.ip ?? 'unknown');
      next();
    },
    jsonBody(MAX_BODY_BYTES, { strict: true }),
    async (req: Request, res: Response) => {
      const parsed = loginRouteRequest.safeParse(req.body);
      if (!parsed.success) {
        throw new ContractViolation('send an organisation slug or an email address', 'login.request_invalid',
          parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code, message: issue.message })));
      }
      const answer = loginRouteResponse.parse(await options.directory.routeLogin(parsed.data));
      res.locals['outcome'] = answer.next;
      res.json(answer);
    });

  // Self-serve sign-up's placement (decision 2026-11-14): the same origin rule and limit.
  app.options(SIGNUP_PLACE_PATH, preflight(cors));
  app.post(SIGNUP_PLACE_PATH,
    (_req, res, next) => {
      const started = performance.now();
      res.on('finish', () => {
        logger.info('sign-up placement', {
          event: 'directory.signup_place', route: SIGNUP_PLACE_PATH, status: res.statusCode,
          outcome: (res.locals['outcome'] as string | undefined) ?? 'error', durationMs: Math.round(performance.now() - started),
        });
      });
      next();
    },
    refuseOtherOrigins(cors, 'signup.origin_refused'),
    (req, _res, next) => {
      limit.take(req.ip ?? 'unknown');
      next();
    },
    jsonBody(MAX_BODY_BYTES, { strict: true }),
    async (req: Request, res: Response) => {
      const parsed = signupPlaceRequest.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ContractViolation('send a residency', 'signup.request_invalid',
          parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code, message: issue.message })));
      }
      const answer = signupPlaceResponse.parse(await options.directory.placeSignup(parsed.data.residency));
      res.locals['outcome'] = answer.next;
      res.json(answer);
    });

  // Its own refusals, as raised: the directory holds nothing a refusal could disclose.
  app.use(notFound(), errorHandler({
    logger, audience: 'service', event: 'directory.login_route_failed', message: 'login routing failed',
    beforeReply: (error, _req, res) => {
      res.locals['outcome'] = isAppError(error) ? error.code : 'unhandled';
    },
  }));

  return {
    name: 'directory.public-listener',
    async run(signal) {
      const server: Server = app.listen(config.publicPort ?? 0, config.publicHost);
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      options.onListening?.((server.address() as AddressInfo).port);
      logger.info('public listener started', { event: 'directory.public_listener_started' });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 5_000).unref();
      await closed;
    },
  };
}
