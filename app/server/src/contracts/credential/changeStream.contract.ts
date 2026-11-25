// The credential service's change-stream endpoints (spec 18.8). A connection's webhook
// signing secret is a connection credential like any other: sealed here, opened here with
// reason change_stream, and never returned, except once, when Silo generated it for the
// owner to copy into the provider. A delivery's signature is checked here, by the
// manifest's verify expression with secret.webhook in scope, and the two signatures are
// compared in constant time; the caller learns only whether it passed.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

/** The credential row's field name for a connection's inbound webhook signing secret. */
export const WEBHOOK_SECRET_FIELD = 'webhook_signing_secret';

export const sealWebhookSecret = defineContract({
  service: 'credential', name: 'sealWebhookSecret', method: 'POST', path: '/v1/webhook-secrets',
  callers: ['change-stream'],
  // Each call replaces the live secret; the caller keys its own operation.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    /** The provider's own secret, where it issues one; absent, Silo generates 256 bits. */
    secret: z.string().min(16).max(4_096).optional(),
  }),
  response: z.object({
    credentialId: z.uuid(),
    lastFour: z.string(),
    /** Only when Silo generated it: shown once, never again. */
    generated: z.string().optional(),
  }),
  maxBodyBytes: 16 * 1024,
});

export const VERIFY_REFUSALS = ['signature', 'replay', 'secret_missing', 'not_declared', 'connection_unusable'] as const;

export const verifyWebhookDelivery = defineContract({
  service: 'credential', name: 'verifyWebhookDelivery', method: 'POST', path: '/v1/webhook-verifications',
  callers: ['change-stream'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    /** The endpoint's sealed secret. */
    credentialId: z.uuid(),
    /** The raw body, exactly as it arrived. */
    body: z.string().max(1024 * 1024),
    /** Lower-cased names. */
    headers: z.record(z.string().regex(/^[a-z0-9!#$%&'*+.^_`|~-]{1,100}$/), z.string().max(8_192)),
  }),
  response: z.discriminatedUnion('valid', [
    z.object({ valid: z.literal(true), signedAt: z.iso.datetime({ offset: true }).optional() }),
    z.object({ valid: z.literal(false), reason: z.enum(VERIFY_REFUSALS) }),
  ]),
  maxBodyBytes: 1200 * 1024,
});
