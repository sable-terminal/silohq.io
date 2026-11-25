// Zod on both sides of every route: the request's path parameters, query and body against
// the route's schemas before any handler runs, and the reply against its response schema
// before it is sent. A request at fault learns the paths and rules it broke, never a value
// echoed back; a reply at fault is the cell's own failure and leaves as an internal error.

import type { RequestHandler } from 'express';
import type { z } from 'zod';
import type { Logger } from '../infra/logger.infra.ts';
import { AppError, ContractViolation, type Issue } from '../utils/errors.util.ts';
import { localsOf } from './request.middleware.ts';

export interface RequestShape {
  params: z.ZodType;
  query: z.ZodType;
  body: z.ZodType;
}

export const issuesOf = (part: string, error: z.ZodError): Issue[] =>
  error.issues.slice(0, 20).map((issue) => ({ path: [part, ...issue.path.map(String)].join('.'), code: issue.code, message: issue.message }));

const isEmptyObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;

/**
 * The validated input, for the steps after. On a browser-facing route a route without a
 * body accepts an empty JSON object for one (emptyObjectIsNoBody).
 */
export function validateRequest(shape: RequestShape, options: { emptyObjectIsNoBody?: boolean } = {}): RequestHandler {
  return (req, res, next) => {
    let body: unknown = req.body;
    if (options.emptyObjectIsNoBody && isEmptyObject(body) && shape.body.safeParse(undefined).success) body = undefined;
    const input: Record<string, unknown> = {};
    const issues: Issue[] = [];
    for (const [part, schema, value] of [
      ['params', shape.params, req.params], ['query', shape.query, { ...req.query }], ['body', shape.body, body],
    ] as [string, z.ZodType, unknown][]) {
      const parsed = schema.safeParse(value);
      if (parsed.success) input[part] = parsed.data;
      else issues.push(...issuesOf(part, parsed.error));
    }
    if (issues.length > 0) throw new ContractViolation('the request does not match its contract', 'contract.request_invalid', issues);
    localsOf(res).input = input as { params: unknown; query: unknown; body: unknown };
    next();
  };
}

/** The reply as its schema parses it, or an internal error when it does not match. `what` names the reply in the log. */
export function checkedReply<T>(schema: z.ZodType<T>, output: unknown, log: Logger, what = 'a response'): T {
  const checked = schema.safeParse(output);
  if (!checked.success) {
    log.error(`${what} did not match its contract`, { event: 'contract.response_invalid', count: checked.error.issues.length });
    throw new AppError('internal', 'the response does not match its contract', { code: 'contract.response_invalid' });
  }
  return checked.data;
}
