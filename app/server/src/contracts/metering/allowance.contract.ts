// Allowances and balances (spec 72.5, 73.3, 73.4, 73.7). An allowance exists only for a
// membership holding an assigned seat: it is created on assignment, prorated to the rest
// of the period, and per membership and period, so it never pools or rolls over. The
// onboarding grant of 200 tokens is given once, on first activation.
//
// A period is a calendar month in the organisation's time zone (this build's default; the
// spec says "per month" and leaves the anchor open). The daily limit counts allowance use
// in the organisation's day.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { units } from './charge.contract.ts';

const timestamp = z.iso.datetime({ offset: true });

const tokenAllowance = z.object({
  granted: z.number().int(),
  consumed: z.number().int(),
  remaining: z.number().int(),
  dailyLimit: z.number().int(),
  dailyConsumed: z.number().int(),
  dailyRemaining: z.number().int(),
});

const simulationAllowance = z.object({ granted: z.number().int(), consumed: units, remaining: units });

const balance = z.object({
  /** Whether tokens are bought for them when they run out (spec 73.4); off unless switched on. */
  autoTopup: z.boolean(),
  onboardingGrantRemaining: z.number().int(),
  purchasedRemaining: z.number().int(),
  simulationsPurchasedRemaining: units,
});

/** Auth calls this when it assigns a seat (spec 72.5). Repeating it changes nothing. */
export const grantAllowance = defineContract({
  service: 'metering', name: 'grantAllowance', method: 'POST', path: '/v1/allowances', callers: ['auth'],
  // Safe to repeat: one allowance per membership and period (unique key), one grant ever.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ membershipId: z.uuid() }),
  response: z.object({
    period: z.object({ start: timestamp, end: timestamp }),
    tokens: tokenAllowance,
    simulations: simulationAllowance,
    /** True when this call created the period's allowance (false: it already existed). */
    granted: z.boolean(),
    /** True when this call gave the onboarding grant (first activation). */
    onboardingGranted: z.boolean(),
  }),
  status: 201,
  maxBodyBytes: 512,
});

/** A person's own allowance, or anyone's under billing.view (spec 71.6). */
export const readAllowance = defineContract({
  service: 'metering', name: 'readAllowance', method: 'GET', path: '/v1/memberships/:membershipId/allowance',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ membershipId: z.uuid() }),
  response: z.object({
    period: z.object({ start: timestamp, end: timestamp }),
    /** Null when the membership holds no seat this period. */
    tokens: tokenAllowance.nullable(),
    simulations: simulationAllowance.nullable(),
    balance,
  }),
});
