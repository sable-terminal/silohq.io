import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isAppError, notFound, toResponse } from '../utils/error.util';
import { redactObject } from '../utils/redact.util';

/**
 * The last thing in the chain, and the only place a status code is chosen.
 *
 * EVERY LAYER BELOW THROWS AND NOTHING BELOW SETS A STATUS. A service that
 * called `res.status(403)` would be a service that cannot be used by a cron, a
 * worker or another service — and the authorisation rule it encodes would apply
 * only to requests that arrived over HTTP. Throwing an `AppError` puts the rule
 * where the decision is and leaves the transport to translate it, here.
 *
 * THE DENIAL/REFUSAL DISTINCTION SURVIVES TO THE WIRE. `toResponse` maps a
 * denial to 403 and a refusal to 422 and never collapses them, because the
 * client renders two different screens: one says who to ask, the other says what
 * to change about the question.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  // Required for Express to recognise this as an error handler. Removing it
  // silently turns this into ordinary middleware that never runs.
  _next: NextFunction,
): void {
  /*
   * A ZOD ERROR REACHING HERE IS A BUG, not a bad request — `validate` converts
   * the ones that come from a client. This catches the ones thrown while parsing
   * something we control, and reports them as ours rather than blaming the
   * caller for a payload they never sent.
   */
  const normalised =
    error instanceof ZodError && !isAppError(error)
      ? Object.assign(new Error('A value failed validation after it was accepted.'), {
          cause: error,
        })
      : error;

  const { status, body } = toResponse(normalised);

  if (status >= 500) {
    req.log.error({ err: normalised, code: body.error.code }, 'Unhandled error');
  } else if (isAppError(normalised)) {
    /*
     * `detail` IS FOR THE LOG AND IS REDACTED BEFORE IT GETS THERE. It exists to
     * make a denial diagnosable — which permission, at which scope — and the
     * same field is where a caller's payload ends up when someone attaches one.
     */
    req.log.warn(
      { code: normalised.code, kind: normalised.kind, detail: redactObject(normalised.detail) },
      normalised.message,
    );
  }

  /*
   * A RESPONSE ALREADY UNDERWAY CANNOT BE REWRITTEN. Writing a second set of
   * headers throws inside the error handler, which Express reports as a
   * different error, and the actual failure is lost. Destroying the socket at
   * least makes the client see a broken response rather than a truncated valid
   * one.
   */
  if (res.headersSent) {
    res.destroy();
    return;
  }

  res.status(status).json(body);
}

/** Anything that matched no route. A 404 with the same body shape as the rest. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    notFound({
      message: `No endpoint at ${req.method} ${req.path}.`,
      code: 'missing.endpoint',
    }),
  );
}
