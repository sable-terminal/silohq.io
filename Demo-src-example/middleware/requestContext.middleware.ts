import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from '../config/logger.config';

/**
 * An id and a logger for every request, before anything else can fail.
 *
 * THE ID IS ECHOED IN THE RESPONSE HEADER because the support question is
 * always "it failed at about half past two" and the answer has to be findable.
 * A user can read `x-request-id` off a failed call and quote it; without it,
 * matching a report to a log line means guessing from timestamps across every
 * tenant that was active in the same second.
 *
 * AN INBOUND `x-request-id` IS TRUSTED ONLY AS A CORRELATION HINT, never as
 * anything security-bearing — the web tier sets it to stitch a page load to its
 * API calls. It is bounded and stripped of anything but the characters a log
 * search expects, because an unbounded client-controlled string ends up in
 * every log line for the request.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.get('x-request-id');
  req.id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  req.log = logger.child({ requestId: req.id });

  res.setHeader('x-request-id', req.id);

  const startedAt = process.hrtime.bigint();

  /*
   * LOGGED ON `finish`, NOT BEFORE THE HANDLER. The status and the duration are
   * the two things worth knowing and neither exists until the response is sent.
   * `close` covers the client that hung up mid-response, which would otherwise
   * be a request that appears in no log at all.
   */
  let logged = false;
  const complete = (aborted: boolean) => {
    if (logged) return;
    logged = true;

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const line = {
      method: req.method,
      // `req.route?.path` rather than the URL: the URL carries ids, and a log
      // grouped by URL has one bucket per resource instead of one per endpoint.
      path: req.route?.path ?? req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      organisationId: req.auth?.organisation.id,
      membershipId: req.auth?.membership.id,
      ...(aborted ? { aborted: true } : {}),
    };

    if (res.statusCode >= 500) req.log.error(line, 'Request failed');
    else if (res.statusCode >= 400) req.log.warn(line, 'Request rejected');
    else req.log.info(line, 'Request');
  };

  res.on('finish', () => complete(false));
  res.on('close', () => complete(true));

  next();
}

/** The client's address, respecting the proxy Cloud Run puts in front of us. */
export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

export function userAgent(req: Request): string | null {
  // Bounded: this is hashed into audit rows, and an unbounded header should not
  // decide how much work the HMAC does.
  return req.get('user-agent')?.slice(0, 512) ?? null;
}
