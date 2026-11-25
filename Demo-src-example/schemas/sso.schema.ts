import { z } from 'zod';
import { email } from '../utils/schemas.util';

/**
 * `issuer` MUST BE HTTPS. An `http` issuer means the discovery document, the
 * key set and the token exchange all travel in clear — at which point none of
 * the verification below it means anything.
 */
export const configure = z
  .object({
    name: z.string().min(1).max(128).trim(),
    issuer: z.string().url().startsWith('https://').max(500),
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(1000),
    domains: z
      .array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Use a bare domain, like acme.com.'))
      .min(1)
      .max(20),
  })
  .strict();

export const begin = z
  .object({ email, returnTo: z.string().max(500).optional() })
  .strict();

/**
 * The callback's query is NOT strict.
 *
 * Providers append their own parameters — `session_state`, `iss`, `scope` — and
 * rejecting a sign-in because a directory sent one field too many would be a
 * failure the customer cannot fix.
 */
export const callback = z.object({
  state: z.string().max(500).optional(),
  code: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
});
