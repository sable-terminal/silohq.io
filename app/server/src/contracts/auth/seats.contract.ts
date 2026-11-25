// Seats (spec 72): a seat is an allocation, with a lifecycle apart from the membership in it.
//
//   purchase → unassigned → assign → assigned → (suspend) reclaimed → assign → assigned
//   assigned → unassign → unassigned → release → released (out of the billable count)
//
// - Purchased seats come from the subscription (billing creates them as it learns the seat
//   count) or, for Enterprise, the contract.
// - Assigning (seat.allocate) takes an available seat from a scope the admin administers, or
//   an organisation-level seat for a holder of seat.allocate organisation-wide. Assigning is
//   what creates the member's allowance, prorated, and on first activation the onboarding
//   grant (73.4): an unassigned seat accrues nothing (72.5). A member who joins by
//   invitation, SSO or SCIM is given an available seat as they join, from their scope's pool
//   or the organisation's, when there is one.
// - A pool held by a scope draws from its parent's, so fifty seats given to Engineering
//   cannot be exceeded however its admins subdivide them.
// - Removing a member leaves the seat untouched (72.4); suspending one reclaims it.
//   Releasing (seat.release) takes an unassigned or reclaimed seat out of the billable count
//   at the period's end; a released seat is never reassigned.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const SEAT_EVENTS = ['seat_allocated', 'seat_pool_allocated', 'seat_assigned', 'seat_unassigned', 'seat_reclaimed', 'seat_released'] as const;
export type SeatEventName = (typeof SEAT_EVENTS)[number];

export const PLAN_TIERS = ['standard', 'business', 'enterprise'] as const;

export const seatView = z.object({
  id: z.uuid(),
  planTier: z.enum(PLAN_TIERS),
  status: z.enum(['unassigned', 'assigned', 'reclaimed', 'released']),
  membershipId: z.uuid().nullable(),
  allocatedScopeId: z.uuid().nullable(),
  createdAt: z.string(),
  releasedAt: z.string().nullable(),
});
export type SeatView = z.infer<typeof seatView>;

export const poolView = z.object({ scopeId: z.uuid(), planTier: z.enum(PLAN_TIERS), seatsAllocated: z.int(), available: z.int() });

export const listSeats = defineContract({
  service: 'auth', name: 'listSeats', method: 'GET', path: '/v1/seats', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    seats: z.array(seatView),
    counts: z.object({ unassigned: z.int(), assigned: z.int(), reclaimed: z.int(), released: z.int() }),
    pools: z.array(poolView),
  }),
});

export const assignSeat = defineContract({
  service: 'auth', name: 'assignSeat', method: 'POST', path: '/v1/seats/assignments', callers: ['gateway'],
  // Assigning a membership that already holds a seat answers with that seat.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    membershipId: z.uuid(),
    /** The scope whose pool the seat comes from; the organisation's seats when absent. */
    scopeId: z.uuid().optional(),
    planTier: z.enum(PLAN_TIERS).optional(),
  }),
  response: z.object({ seat: seatView, allowanceGranted: z.boolean(), onboardingGranted: z.boolean() }),
  status: 201,
});

export const unassignSeat = defineContract({
  service: 'auth', name: 'unassignSeat', method: 'POST', path: '/v1/seats/:seatId/unassign', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ seatId: z.uuid() }),
  response: seatView,
});

export const releaseSeat = defineContract({
  service: 'auth', name: 'releaseSeat', method: 'POST', path: '/v1/seats/:seatId/release', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ seatId: z.uuid() }),
  response: seatView,
});

export const allocateSeatPool = defineContract({
  service: 'auth', name: 'allocateSeatPool', method: 'POST', path: '/v1/seats/pools', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ scopeId: z.uuid(), planTier: z.enum(PLAN_TIERS), seats: z.int().min(0).max(100_000) }),
  response: poolView,
});
