// Seat counts and the payment provider (spec 72.2, 74.5: "seat count synced on change").
//
// buySeats (billing.manage): adds seats to the self-serve subscription. The provider prorates
// the addition to the rest of the period and invoices it now; the subscription is mirrored at
// once, so the seats arrive unassigned, billed from purchase. 500 seats and above are quoted
// (72.1), and an Enterprise contract's seats come with the contract.
//
// syncSeatCount (auth, after a seat is released): the provider's count follows the seats
// still billable. Releasing reduces it with no proration, so the current invoice is neither
// reduced nor refunded and the next one bills the lower count (72.2). Billing's sweep makes
// the same correction for any subscription whose count is above its billable seats.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const buySeats = defineContract({
  service: 'billing', name: 'buySeats', method: 'POST', path: '/v1/subscription/seats', callers: ['gateway'],
  // The provider is called under a key derived from this request's, so a retry buys once.
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({ seats: z.int().min(1).max(498) }),
  response: z.object({ seatCount: z.int().min(1), added: z.int().min(0) }),
  status: 201,
  maxBodyBytes: 256,
});

export const syncSeatCount = defineContract({
  service: 'billing', name: 'syncSeatCount', method: 'POST', path: '/v1/subscription/seat-count', callers: ['auth'],
  // Safe to repeat: it sets the provider's count to the billable seats, whatever it was.
  context: 'organisation', idempotency: 'none',
  response: z.object({ seatCount: z.int().min(1).nullable(), changed: z.boolean() }),
  maxBodyBytes: 256,
});
