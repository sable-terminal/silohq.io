import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, ZodError, type ZodType } from 'zod';
import { invalid } from '../utils/error.util';

/**
 * Parsing the request before a handler sees it.
 *
 * THE RESULT GOES ON `req.valid`, NOT BACK ONTO `req.body`. Express 5 makes
 * `req.query` a getter, so the familiar `req.query = parsed` throws at runtime
 * rather than at compile time — and half the point of parsing is to hand the
 * handler a typed value rather than the raw one. A handler that reads
 * `req.valid.body` cannot accidentally read an unparsed field, because the
 * unparsed object is a different object.
 *
 * A ZOD FAILURE IS `invalid`, WHICH IS 400 — never 422. 422 belongs to a refusal,
 * which means Silo understood the request and will not answer it; a malformed
 * payload is not that. Collapsing them would make "your JSON is wrong" and "this
 * question cannot be answered within its bounds" the same status to a client
 * that has to render two different screens.
 */

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/** The paths and messages, flattened into something a form can render. */
function issuesOf(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    // First failure per field wins: a field with three problems shows the first,
    // which is the one the user has to fix before the others become meaningful.
    out[path] ??= issue.message;
  }
  return out;
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const valid: { body?: unknown; query?: unknown; params?: unknown } = {};

    for (const part of ['body', 'query', 'params'] as const) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);
      if (!result.success) {
        next(
          invalid({
            message: 'Check the highlighted fields.',
            code: `invalid.${part}`,
            /*
             * `fields`, NOT `detail`. `detail` is log-only and is dropped by
             * `toResponse`, so putting them there meant the form was told
             * something was wrong and never which thing.
             */
            fields: issuesOf(result.error),
          }),
        );
        return;
      }

      valid[part] = result.data;
    }

    req.valid = valid;
    next();
  };
}

/**
 * Reading a validated part back out, typed.
 *
 * The cast is contained to this one function. Every handler goes through it, so
 * there is exactly one place where the compiler is being asked to trust the
 * middleware, rather than one per handler.
 */
export function body<T>(req: Request): T {
  return req.valid?.body as T;
}

export function query<T>(req: Request): T {
  return req.valid?.query as T;
}

export function params<T>(req: Request): T {
  return req.valid?.params as T;
}

/** A uuid path parameter, which is most of them. */
export const uuidParam = (name: string) => z.object({ [name]: z.string().uuid() });
