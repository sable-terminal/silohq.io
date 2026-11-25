// Outbound Action event signing (spec 48.3): each subscription's HMAC-SHA256 secret is held
// here. It is generated here (256 random bits) and sealed as a connection credential of
// purpose action_event_secret, belonging to no connection; the subscriber sees it once, when
// the subscription is created, to verify deliveries. Notify asks for each delivery's
// signature and never sees the secret: the HMAC is computed inside the open callback, with
// reason action_event in the unwrap ledger.
//
// The signature is HMAC-SHA256 over `${timestamp}.${body}`, hex, sent as `v1=<hex>` with the
// timestamp beside it, so a subscriber can refuse a replay.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const createActionEventSecret = defineContract({
  service: 'credential', name: 'createActionEventSecret', method: 'POST', path: '/v1/action-event-secrets',
  callers: ['actions'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({}),
  response: z.object({
    credentialId: z.uuid(),
    lastFour: z.string(),
    /** Shown once, to the person creating the subscription; never again. */
    secret: z.string(),
  }),
  maxBodyBytes: 256,
});

export const signActionEvent = defineContract({
  service: 'credential', name: 'signActionEvent', method: 'POST', path: '/v1/action-event-signatures',
  callers: ['notify'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    credentialId: z.uuid(),
    /** Unix seconds, as sent in the delivery's timestamp header. */
    timestamp: z.string().regex(/^\d{1,12}$/),
    /** The delivery body exactly as it is sent. */
    body: z.string().max(1024 * 1024),
  }),
  response: z.object({ signature: z.string().regex(/^v1=[0-9a-f]{64}$/) }),
  maxBodyBytes: 1100 * 1024,
});
