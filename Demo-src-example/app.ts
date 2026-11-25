import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.config';
import { apiRouter } from './routes';
import * as health from './controllers/health.controller';
import { requestContext } from './middleware/requestContext.middleware';
import { generalLimit } from './middleware/rateLimit.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';

/**
 * The application, assembled.
 *
 * ORDER IS THE WHOLE FILE. Middleware runs in the order it is added, and three
 * of these placements are load-bearing:
 *
 *   `requestContext` FIRST, so that every later failure — including one thrown
 *   by the body parser on malformed JSON — has a request id and a logger. An
 *   error thrown before it would reach the error handler, which reads `req.log`,
 *   and fail there instead.
 *
 *   HEALTH BEFORE THE RATE LIMIT. Cloud Run probes on a fixed interval from a
 *   small set of addresses; putting the probes behind a per-address limit means
 *   a busy instance eventually fails its own health check and is killed for
 *   being busy.
 *
 *   THE ERROR HANDLER LAST, AFTER THE 404. Express picks the first matching
 *   layer, so an error handler registered before the routes never sees anything
 *   they throw.
 */
export function createApp(): Express {
  const app = express();

  /*
   * TRUSTS EXACTLY ONE PROXY. Cloud Run puts one in front of every container, so
   * the real client address is the last entry in `X-Forwarded-For`. `true` would
   * trust the whole chain — including the part a client wrote itself — which
   * makes `req.ip` attacker-controlled, and `req.ip` is what the credential rate
   * limiter counts against.
   */
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestContext);

  app.get('/healthz', health.live);
  app.get('/readyz', health.ready);
  app.get('/metrics', health.metrics);

  app.use(
    helmet({
      /*
       * NO CSP HERE. This process serves JSON and never HTML, so a content
       * policy has nothing to govern — and a default policy on an API is a rule
       * that looks like protection while protecting nothing. The web app sets
       * its own, over the documents that actually execute script.
       */
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  /*
   * ONE ORIGIN, AND CREDENTIALS. The session cookie only travels if the browser
   * is told this origin may send it, and `origin: true` — reflecting whatever
   * asked — combined with `credentials: true` means any site can make
   * authenticated calls on a signed-in user's behalf. Naming the origin is what
   * makes the cookie safe to have.
   */
  app.use(
    cors({
      origin: env.APP_URL,
      credentials: true,
      exposedHeaders: ['x-request-id', 'retry-after', 'x-ratelimit-remaining'],
    }),
  );

  /*
   * A SMALL BODY LIMIT. Nothing on this router accepts a document; uploads go to
   * object storage through a signed URL and never through this process. The
   * default of 100kb is already generous for a JSON payload of ids.
   */
  app.use(express.json({ limit: '256kb' }));

  app.use(generalLimit);
  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
