import { z } from 'zod';

/**
 * Billing at the door.
 *
 * THE TERM IS NEVER DEFAULTED. Monthly and annual are different prices and
 * different commitments, and guessing on somebody's behalf is the one field in
 * a subscription form nobody would forgive being wrong.
 */

export const subscribe = z
  .object({
    plan: z.enum(['standard', 'business', 'enterprise']),
    seats: z.number().int().min(1).max(5_000),
    term: z.enum(['monthly', 'annual']),
  })
  .strict();

export const seatCount = z.object({ count: z.number().int().min(1).max(500) }).strict();

export const buyTokens = z.object({ tokens: z.number().int().min(1).max(100_000) }).strict();

/* §4 — "opt-in, never default", so the request says which, and nothing defaults. */
export const autoTopUp = z.object({ enabled: z.boolean() }).strict();

/**
 * BILLING §2 — the organisation's own daily ceiling.
 *
 * NULL IS A VALUE HERE, NOT AN OMISSION: it means "follow the plan", which on
 * Enterprise means no limit at all. An absent field would read as "leave it
 * alone", and the two need telling apart.
 */
export const dailyLimit = z
  .object({ dailyLimit: z.number().int().min(1).max(100_000).nullable() })
  .strict();
