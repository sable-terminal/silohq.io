// The response headers of every browser-facing listener (the public API and the staff
// console). Responses are never cached (Cache-Control: no-store; spec 30.7), never framed,
// never sniffed, and send no referrer.

import type { RequestHandler } from 'express';

export const SECURITY_HEADERS: readonly [string, string][] = [
  ['strict-transport-security', 'max-age=63072000; includeSubDomains'],
  ['content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'no-referrer'],
  ['cross-origin-opener-policy', 'same-origin'],
  ['cross-origin-resource-policy', 'same-origin'],
  ['cache-control', 'no-store'],
];

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    for (const [name, value] of SECURITY_HEADERS) res.setHeader(name, value);
    next();
  };
}
