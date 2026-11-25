import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isConfigured, verify } from '../utils/turnstile.util';
import { clientIp } from './requestContext.middleware';
import { denial } from '../utils/error.util';
import { isProd } from '../config/env.config';
import { childLogger } from '../config/logger.config';

const log = childLogger('turnstile');

/*
 * SAID ONCE, AT THE FIRST UNPROTECTED REQUEST, AND LOUDLY IN PRODUCTION. A bot
 * check that is not configured is a bot check that is not running, and the
 * failure mode is silence — the forms work, the deploy is green, and the only
 * symptom is signups nobody made. Logging it per request would bury it; logging
 * it never is how it stays missing for a month.
 */
let warned = false;

/**
 * Require a Turnstile token on a public form.
 *
 * IT SKIPS WHEN NO SECRET IS SET, deliberately, so the product is usable before
 * the keys exist and on every developer's machine. That is a fail-open, and it
 * is the only one here: it is bounded to a control that has never been turned
 * on, and production says so at ERROR on the first request through.
 *
 * WHEN CLOUDFLARE IS UNREACHABLE IT FAILS OPEN TOO, and that is the harder
 * call. Failing closed would mean a Cloudflare outage takes down registration
 * and password reset for everybody — trading a real, total outage for a
 * hypothetical burst of spam that the credential rate limiter still bounds.
 * The rate limiter is what makes that trade survivable, so the two belong on
 * the same routes.
 */
export function requireHuman(action: string): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!isConfigured()) {
      if (!warned) {
        warned = true;
        const message =
          'Turnstile is not configured, so the public forms have no bot protection.';
        if (isProd) log.error({ action }, message);
        else log.warn({ action }, `${message} Development only.`);
      }
      next();
      return;
    }

    const token = (req.body as { turnstileToken?: unknown } | undefined)?.turnstileToken;
    const result = await verify(typeof token === 'string' ? token : null, clientIp(req));

    if (result.outcome === 'passed' || result.outcome === 'unavailable') {
      if (result.outcome === 'unavailable') {
        log.warn({ action }, 'Turnstile unreachable; allowing the request through');
      }
      next();
      return;
    }

    if (result.outcome === 'skipped') {
      next();
      return;
    }

    log.info({ action, codes: result.codes }, 'Turnstile rejected a submission');
    next(
      denial({
        message: 'That looked automated. Refresh the page and try again.',
        code: 'denial.turnstile',
        detail: { action, codes: result.codes },
      }),
    );
  };
}
