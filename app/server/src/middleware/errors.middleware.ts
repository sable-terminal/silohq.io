// Errors as they leave a listener: one body shape (contracts/endpoint ErrorBody), with
// Retry-After where a refusal names a wait. A foreign error's message never leaves the
// process or reaches a log; a failure (not a refusal) is logged once, here.
//
// To another service the error goes as raised. To a browser (publicError) what is about
// the request passes through and what is about the cell's insides is withheld: a refusal
// (validation, authentication, permission, conflict, rate limit, bound) keeps its code,
// message and details, less the name of the internal service that raised it; a failure
// inside the cell keeps its category and code, so it can be traced by the correlation id,
// with a generic message and no details.

import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import type { ErrorBody } from '../contracts/endpoint.contract.ts';
import type { Logger } from '../infra/logger.infra.ts';
import { AppError, ContractViolation, isAppError, type ErrorCategory } from '../utils/errors.util.ts';
import { localsOf } from './request.middleware.ts';

export interface ErrorReply {
  status: number;
  body: ErrorBody;
  retryAfterSeconds: number | undefined;
}

export function errorBodyOf(error: unknown): ErrorReply {
  const appError = isAppError(error) ? error : new AppError('internal', 'internal error', { code: 'unhandled' });
  const body: ErrorBody = {
    error: {
      category: appError.category,
      code: appError.code,
      message: appError.message,
      retryable: appError.retryable,
      ...(appError.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: appError.retryAfterSeconds }),
      ...(Object.keys(appError.details).length === 0 ? {} : { details: { ...appError.details } }),
      ...(appError instanceof ContractViolation ? { issues: [...appError.issues] } : {}),
    },
  };
  return { status: appError.httpStatus, body, retryAfterSeconds: appError.retryAfterSeconds };
}

const ABOUT_THE_REQUEST: ReadonlySet<ErrorCategory> = new Set([
  'validation', 'unauthenticated', 'forbidden', 'not_found', 'conflict', 'rate_limited', 'bounds',
]);

const GENERIC: Partial<Record<ErrorCategory, string>> = {
  capacity: 'the service is busy; try again shortly',
  unavailable: 'the service is unavailable; try again shortly',
  source_unreachable: 'a source is unreachable; try again shortly',
  timeout: 'the request took too long; try again',
};

export function publicError(error: unknown): ErrorReply {
  if (isAppError(error) && ABOUT_THE_REQUEST.has(error.category)) {
    const { service: _service, ...details } = error.details;
    return errorBodyOf(Object.keys(details).length === Object.keys(error.details).length ? error : new AppError(error.category, error.message, {
      code: error.code, details, retryable: error.retryable,
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    }));
  }
  const category: ErrorCategory = isAppError(error) ? error.category : 'internal';
  return errorBodyOf(new AppError(category, GENERIC[category] ?? 'something went wrong; quote the correlation id if it persists', {
    code: isAppError(error) ? error.code : 'unhandled',
    retryable: isAppError(error) ? error.retryable : false,
    ...(isAppError(error) && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  }));
}

/** Logs a failure (never a refusal) and sends the reply, unless one was already sent. */
export function sendError(res: Response, reply: ErrorReply, error: unknown, log: Logger, failure: { event: string; message: string }): void {
  if (reply.status >= 500 && !(isAppError(error) && error.refusal)) log.failure(failure.message, error, { event: failure.event });
  if (res.headersSent) return;
  if (reply.retryAfterSeconds !== undefined) res.setHeader('retry-after', String(reply.retryAfterSeconds));
  res.status(reply.status).json(reply.body);
}

export interface ErrorHandlerOptions {
  logger: Logger;
  /** Who reads the error: another service, or a browser. */
  audience: 'service' | 'public';
  /** The log line of a failure. */
  event: string;
  message: string;
  /** Before the reply is sent, for a listener's own headers (clearing a cookie that names no session). */
  beforeReply?: (error: unknown, req: Request, res: Response) => void;
}

/** The last step of every pipeline. */
export function errorHandler(options: ErrorHandlerOptions): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    const locals = localsOf(res);
    locals.failure = error;
    if (!res.headersSent) options.beforeReply?.(error, req, res);
    const reply = options.audience === 'public' ? publicError(error) : errorBodyOf(error);
    sendError(res, reply, error, locals.log ?? options.logger, options);
  };
}

/** Every path the listener does not serve. */
export function notFound(): RequestHandler {
  return () => {
    throw new AppError('not_found', 'no such endpoint', { code: 'route.not_found' });
  };
}
