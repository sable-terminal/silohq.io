import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { check, type FailureMode } from '../infra/rateLimiter.infra';
import {
  RATE_LIMIT_LOGIN_PER_MINUTE,
  RATE_LIMIT_REQUESTS_PER_MINUTE,
} from '../config/constants.config';
import { limited } from '../utils/error.util';
import { clientIp } from './requestContext.middleware';

/**
 * Rate limiting, and the two different things it is for.
 *
 * THE GENERAL LIMIT PROTECTS THE SERVICE and fails OPEN. If the cache is down,
 * refusing every request turns a degraded dependency into a total outage, and
 * the thing being protected against is accidental load rather than an attacker.
 *
 * THE CREDENTIAL LIMIT PROTECTS ACCOUNTS and fails CLOSED. Failing open there
 * would mean an unlimited password-guessing window that opens exactly when the
 * cache is unavailable — which is a state an attacker can sometimes cause. The
 * account lockout in `auth.service` is the second line, but it is per-account and
 * this is per-address: it is what stops one address working through a list of
 * accounts, touching each one too few times to lock any of them.
 */

interface LimitOptions {
  kind: string;
  limit: number;
  windowSeconds: number;
  onUnavailable: FailureMode;
  /** What counts as one caller. Defaults to the client address. */
  subject?: (req: Request) => string;
}

function limiter(options: LimitOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const subject = options.subject?.(req) ?? clientIp(req) ?? 'unknown';

    const result = await check({
      kind: options.kind,
      subject,
      limit: options.limit,
      windowSeconds: options.windowSeconds,
      onUnavailable: options.onUnavailable,
    });

    res.setHeader('x-ratelimit-limit', String(result.limit));
    res.setHeader('x-ratelimit-remaining', String(Math.max(0, result.limit - result.count)));

    if (result.allowed) {
      next();
      return;
    }

    res.setHeader('retry-after', String(result.retryAfterSeconds));

    next(
      limited({
        message: `Too many requests. Try again in ${result.retryAfterSeconds} seconds.`,
        code: `limit.${options.kind}`,
        detail: { kind: options.kind, degraded: result.degraded },
      }),
    );
  };
}

/** Every request. Broad and generous; catches runaway clients, not attackers. */
export const generalLimit = limiter({
  kind: 'request',
  limit: RATE_LIMIT_REQUESTS_PER_MINUTE,
  windowSeconds: 60,
  onUnavailable: 'open',
});

/**
 * Anything that takes a credential: login, reset, invitation acceptance, MFA.
 *
 * KEYED ON ADDRESS AND NOT ON THE ACCOUNT NAMED. Keying on the email would let
 * an attacker spread guesses across accounts for free, and would let anyone lock
 * a known address out of its own reset flow by exhausting its bucket.
 */
export const credentialLimit = limiter({
  kind: 'credential',
  limit: RATE_LIMIT_LOGIN_PER_MINUTE,
  windowSeconds: 60,
  onUnavailable: 'closed',
});

/** Writes by an authenticated member, keyed on the membership. */
export const writeLimit = limiter({
  kind: 'write',
  limit: 120,
  windowSeconds: 60,
  onUnavailable: 'open',
  subject: (req) => req.auth?.membership.id ?? clientIp(req) ?? 'unknown',
});
