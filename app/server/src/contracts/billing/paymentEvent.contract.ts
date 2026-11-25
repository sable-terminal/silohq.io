// The payment provider's webhook (spec 74.5, 75.3): the single source of payment state.
// The gateway receives it on the cell's hooks host and forwards the raw payload, exactly
// as received, with the provider's signature header. Billing verifies the signature over
// those bytes, learns the tenant from the verified event's metadata, and writes the
// subscription mirror, entitlements and billing status. Nothing else reads the provider.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const MAX_PAYMENT_EVENT_BYTES = 256 * 1024;

export const receivePaymentEvent = defineContract({
  service: 'billing', name: 'receivePaymentEvent', method: 'POST', path: '/v1/payment-events', callers: ['gateway'],
  // The provider retries; applying an event twice writes nothing new (state is compared under lock).
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    /** The request body as received, unparsed: the signature covers these bytes. */
    payload: z.string().min(2).max(MAX_PAYMENT_EVENT_BYTES),
    /** The provider's signature header, verbatim. */
    signature: z.string().min(1).max(2048),
  }),
  response: z.object({ outcome: z.enum(['applied', 'ignored']) }),
  // JSON escaping can grow the payload.
  maxBodyBytes: 3 * MAX_PAYMENT_EVENT_BYTES,
});
