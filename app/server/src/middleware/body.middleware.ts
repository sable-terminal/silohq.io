// Reading the request body, bounded. JSON for every API; a provider's signed webhook as
// raw bytes, forwarded unparsed with its signature header verbatim for the receiving
// service to verify. A body over its bound is refused, never truncated.

import express, { type RequestHandler } from 'express';
import { AppError, refuse } from '../utils/errors.util.ts';

interface Fallback {
  code: string;
  message: string;
}

const NOT_JSON: Fallback = { code: 'request.json_invalid', message: 'the request body is not valid JSON' };

// Body-parser's errors carry a type and no code.
function bodyError(error: unknown, limit: number, fallback: Fallback): AppError {
  const type = (error as { type?: unknown } | null)?.type;
  if (type === 'entity.too.large') return refuse.bound('request_body_bytes', limit);
  if (type === 'entity.parse.failed') return new AppError('validation', NOT_JSON.message, { code: NOT_JSON.code });
  if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
    return new AppError('validation', 'the request body must be UTF-8 JSON', { code: 'request.encoding_unsupported' });
  }
  return new AppError('validation', fallback.message, { code: fallback.code });
}

/** A JSON body of at most limit bytes. Strict mode accepts only an object or array at the top. */
export function jsonBody(limit: number, options: { strict?: boolean; fallback?: Fallback } = {}): RequestHandler {
  const parse = express.json({ limit, strict: options.strict ?? false, type: 'application/json' });
  const fallback = options.fallback ?? NOT_JSON;
  return (req, res, next) => {
    parse(req, res, (error?: unknown) => {
      if (error === undefined) next();
      else next(bodyError(error, limit, fallback));
    });
  };
}

/**
 * A provider's webhook: the raw body, which must be UTF-8 and signed, becomes
 * { payload, signature } for the route's schema.
 */
export function signedBody(webhook: { signatureHeader: string; maxBytes: number }, maxBodyBytes: number): RequestHandler {
  const limit = Math.min(webhook.maxBytes, maxBodyBytes);
  const parse = express.raw({ limit, type: () => true });
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  return (req, res, next) => {
    parse(req, res, (error?: unknown) => {
      if (error !== undefined) {
        next(bodyError(error, limit, NOT_JSON));
        return;
      }
      const signature = req.headers[webhook.signatureHeader];
      if (typeof signature !== 'string' || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        next(new AppError('unauthenticated', 'a signed body is required', { code: 'gateway.webhook_unsigned' }));
        return;
      }
      let payload: string;
      try {
        payload = utf8.decode(req.body);
      } catch {
        next(new AppError('validation', 'the body is not UTF-8', { code: 'request.encoding' }));
        return;
      }
      req.body = { payload, signature };
      next();
    });
  };
}
