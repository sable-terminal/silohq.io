// Tracing on the service listener (spec 13.1): each request runs in a span that continues
// the caller's trace (W3C traceparent and tracestate) and lasts until the response is
// sent, so calls the handler makes join the same trace.

import type { RequestHandler } from 'express';
import { inSpan, withExtractedTraceContext } from '../infra/telemetry.infra.ts';
import { localsOf } from './request.middleware.ts';

export function traceSpan(routeId: string): RequestHandler {
  return (req, res, next) => {
    const carrier: Record<string, string> = {};
    for (const name of ['traceparent', 'tracestate']) {
      const value = req.headers[name];
      if (typeof value === 'string') carrier[name] = value;
    }
    void withExtractedTraceContext(carrier, () => inSpan(`http ${routeId}`, { route: routeId, correlationId: localsOf(res).correlationId },
      () => new Promise<void>((resolve) => {
        res.once('close', () => resolve());
        next();
      })));
  };
}
