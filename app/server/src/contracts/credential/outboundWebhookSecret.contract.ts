// Outbound webhook signing (spec 20.4): each target's HMAC-SHA256 secret is generated and held
// here, sealed as a connection credential of purpose outbound_webhook_secret on the target's
// connection, and shown once to whoever registers the target. Notify asks for each delivery's
// signature and never sees the secret: the HMAC is computed inside the open callback, with
// reason webhook in the unwrap ledger.
//
// The signature is HMAC-SHA256 over `${timestamp}.${body}`, hex, sent as `v1=<hex>`, as an
// Action event's is.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const createOutboundWebhookSecret = defineContract({
  service: 'credential', name: 'createOutboundWebhookSecret', method: 'POST', path: '/v1/outbound-webhook-secrets',
  callers: ['connect-registry'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ connectionId: z.uuid() }),
  response: z.object({ credentialId: z.uuid(), lastFour: z.string(), /** Shown once; never again. */ secret: z.string() }),
  maxBodyBytes: 256,
});

export const signOutboundWebhook = defineContract({
  service: 'credential', name: 'signOutboundWebhook', method: 'POST', path: '/v1/outbound-webhook-signatures',
  callers: ['notify'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    credentialId: z.uuid(),
    timestamp: z.string().regex(/^\d{1,12}$/),
    body: z.string().max(1024 * 1024),
  }),
  response: z.object({ signature: z.string().regex(/^v1=[0-9a-f]{64}$/) }),
  maxBodyBytes: 1100 * 1024,
});
