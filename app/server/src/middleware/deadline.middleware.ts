// The request timeout on the service listener: the handler's signal aborts when the
// timeout passes (the listener's, or the contract's declared bound where longer) or the
// caller goes away, and the request is answered then. The work may
// outlive it; a keyed operation still records its result.

import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors.util.ts';
import { localsOf } from './request.middleware.ts';

export function deadline(routeId: string, timeoutMs: number): RequestHandler {
  return (_req, res, next) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new AppError('timeout', `${routeId} did not finish within ${timeoutMs} ms`, {
      code: 'request.timeout', retryable: true,
    })), timeoutMs);
    res.on('close', () => {
      clearTimeout(timer);
      if (!res.writableFinished) controller.abort(new AppError('unavailable', 'the caller went away', { code: 'request.caller_gone' }));
    });
    localsOf(res).signal = controller.signal;
    next();
  };
}

/** The work's result, or the signal's reason if it aborts first. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([work, new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })]);
}
