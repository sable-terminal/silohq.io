// Seats (spec 72), owned by auth with memberships and scopes. The rows are billing.seats and
// billing.seat_allocations; purchased seats are created by billing as it learns the count.
//
// - Assigning takes an available seat (unassigned or reclaimed) from the scope's pool, or the
//   organisation's own seats, locked so two assignments never take one seat. After the
//   assigning transaction commits, metering creates the member's allowance and, on first
//   activation, the onboarding grant (72.5, 73.4).
// - A joining member (invitation, SSO, SCIM) is given a seat in the joining transaction when
//   one is available; without one they join seatless, and an admin assigns one later.
// - Pools: giving a scope seats moves available seats from its parent's pool (the
//   organisation's, for a top-level scope); taking them back moves available ones back. A
//   pool can never hold more than its parent had free.
// - Unassigning frees a seat at once; releasing takes an unassigned or reclaimed seat out of
//   the billable count at the period's end, and it is never reassigned. A released purchased
//   seat is then taken off the provider's count with no refund (billing syncSeatCount; the
//   billing sweep catches one that was missed).

import { syncSeatCount } from '../../contracts/billing/seats.contract.ts';
import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import type { SeatEventName, SeatView } from '../../contracts/auth/seats.contract.ts';
import { grantAllowance } from '../../contracts/metering/allowance.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { Seat } from '../../models/billing/index.model.ts';
import { seatAllocationRepo, seatRepo } from '../../repos/billing/index.repo.ts';
import { membershipRepo, scopeRepo } from '../../repos/iam/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { AuthDeps } from './deps.service.ts';

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

export function seatView(s: Seat): SeatView {
  return {
    id: s.id, planTier: s.planTier, status: s.status, membershipId: s.membershipId, allocatedScopeId: s.allocatedScopeId, createdAt: s.createdAt,
    releasedAt: s.releasedAt,
  };
}

/** A seat event, in the change's own transaction (spec 72.7). */
export async function recordSeatEvent(db: Queryable, request: RequestContext, correlationId: string, e: {
  event: SeatEventName; subjectMembershipId?: string | null; detail: Record<string, string | number | boolean | null>;
}): Promise<void> {
  const actor: AuditActor = request.membershipId !== undefined ? { kind: 'membership', membershipId: request.membershipId } : { kind: 'service', service: 'auth' };
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor, subjectMembershipId: e.subjectMembershipId ?? null, scopeId: null, resource: null, purposeSessionId: null,
    operatorAccessSessionId: null, ipHash: null, detail: e.detail,
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: request.organisationId!, topic: auditEventMessage.topic, orderingKey: request.organisationId!,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}

async function allowed(deps: Pick<AuthDeps, 'services'>, ctx: Context, permission: string, where: { scopeId?: string | null; organisationWide?: true } = {})
  : Promise<boolean> {
  const body = where.scopeId != null ? { permission, scopeId: where.scopeId } : where.organisationWide ? { permission, organisationWide: true as const } : { permission };
  return (await deps.services.call(authorise, { body }, { request: ctx.request, correlationId: ctx.correlationId })).decision === 'allow';
}

async function demand(deps: Pick<AuthDeps, 'services'>, ctx: Context, permission: string, where: { scopeId?: string | null; organisationWide?: true } = {}) {
  if (!await allowed(deps, ctx, permission, where)) {
    throw new AppError('forbidden', `you do not hold ${permission} there`, { code: 'seats.not_permitted', details: { permission } });
  }
}

function person(ctx: Context): string {
  if (ctx.request.membershipId === undefined) throw new AppError('forbidden', 'seats are managed by a person', { code: 'seats.person_required' });
  return ctx.request.membershipId;
}

// ----------------------------------------------------------------------------- joining

/**
 * Inside a joining transaction: an available seat for the new member, from their scope's pool
 * or the organisation's. Undefined when none is free: they join seatless.
 */
export async function seatOnJoin(db: Queryable, request: RequestContext, correlationId: string, membershipId: string, scopeId: string | null)
  : Promise<Seat | undefined> {
  if (await seatRepo.findAssigned(db, membershipId) !== undefined) return undefined;
  const seat = (scopeId === null ? undefined : await seatRepo.takeAvailable(db, scopeId, undefined)) ?? await seatRepo.takeAvailable(db, null, undefined);
  if (seat === undefined) return undefined;
  const assigned = (await seatRepo.update(db, seat.id, { status: 'assigned', membershipId }))!;
  await recordSeatEvent(db, request, correlationId, {
    event: 'seat_assigned', subjectMembershipId: membershipId, detail: { seat_id: seat.id, scope_id: seat.allocatedScopeId, how: 'join' },
  });
  return assigned;
}

/** After the assigning transaction commits: the allowance, and the onboarding grant on first activation. */
export async function grantAfterAssignment(deps: Pick<AuthDeps, 'services' | 'logger' | 'databases'>, organisationId: string, membershipId: string,
  correlationId: string): Promise<{ granted: boolean; onboardingGranted: boolean }> {
  // A member who joined seatless has no allowance until an admin assigns them a seat.
  const seated = await inTransaction(deps.databases.pool('control'), { organisationId }, (db) => seatRepo.findAssigned(db, membershipId), { readOnly: true });
  if (seated === undefined) return { granted: false, onboardingGranted: false };
  try {
    const out = await deps.services.call(grantAllowance, { body: { membershipId } }, { request: { organisationId }, correlationId });
    return { granted: out.granted, onboardingGranted: out.onboardingGranted };
  } catch (error) {
    // The seat stands; the allowance is granted again on the next assignment or by an admin.
    deps.logger.failure('a seat was assigned but its allowance was not granted', error, { event: 'seats.allowance_failed', organisationId });
    return { granted: false, onboardingGranted: false };
  }
}

// ----------------------------------------------------------------------------- managing

export async function listSeats(deps: AuthDeps, ctx: Context) {
  person(ctx);
  if (!await allowed(deps, ctx, 'seat.allocate') && !await allowed(deps, ctx, 'billing.view')) {
    throw new AppError('forbidden', 'you need seat.allocate or billing.view', { code: 'seats.not_permitted' });
  }
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const seats = await seatRepo.list(db);
    const counts = { unassigned: 0, assigned: 0, reclaimed: 0, released: 0 };
    for (const s of seats) counts[s.status] += 1;
    const pools = await Promise.all((await seatAllocationRepo.list(db)).map(async (p) => ({
      scopeId: p.scopeId, planTier: p.planTier, seatsAllocated: p.seatsAllocated, available: await seatRepo.countAvailable(db, p.scopeId, p.planTier),
    })));
    return { seats: seats.map(seatView), counts, pools };
  }, { readOnly: true });
}

export async function assignSeat(deps: AuthDeps, ctx: Context, input: { membershipId: string; scopeId?: string | undefined; planTier?: Seat['planTier'] | undefined })
  : Promise<{ seat: SeatView; allowanceGranted: boolean; onboardingGranted: boolean }> {
  person(ctx);
  // From a scope's pool for a holder of seat.allocate there; the organisation's seats need it organisation-wide.
  await demand(deps, ctx, 'seat.allocate', input.scopeId === undefined ? { organisationWide: true } : { scopeId: input.scopeId });
  const organisationId = ctx.request.organisationId!;
  const seat = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const membership = await membershipRepo.findById(db, input.membershipId);
    if (membership === undefined || membership.status !== 'active') {
      throw new AppError('conflict', 'a seat is assigned to an active membership', { code: 'seats.membership_inactive' });
    }
    const held = await seatRepo.findAssigned(db, input.membershipId);
    if (held !== undefined) return held;
    const free = await seatRepo.takeAvailable(db, input.scopeId ?? null, input.planTier);
    if (free === undefined) {
      throw new AppError('conflict', 'no seat is free there: buy one, release a pool, or unassign one', { code: 'seats.none_available' });
    }
    const assigned = (await seatRepo.update(db, free.id, { status: 'assigned', membershipId: input.membershipId }))!;
    await recordSeatEvent(db, ctx.request, ctx.correlationId, {
      event: 'seat_assigned', subjectMembershipId: input.membershipId, detail: { seat_id: free.id, scope_id: free.allocatedScopeId, how: 'admin' },
    });
    return assigned;
  });
  const granted = await grantAfterAssignment(deps, organisationId, input.membershipId, ctx.correlationId);
  return { seat: seatView(seat), allowanceGranted: granted.granted, onboardingGranted: granted.onboardingGranted };
}

/** The seat goes back to its pool at once; the member keeps their membership (72.4). */
export async function unassignSeat(deps: AuthDeps, ctx: Context, seatId: string): Promise<SeatView> {
  person(ctx);
  const seat = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => seatRepo.findById(db, seatId), { readOnly: true });
  if (seat === undefined) throw new AppError('not_found', 'no such seat', { code: 'seats.not_found' });
  await demand(deps, ctx, 'seat.allocate', seat.allocatedScopeId === null ? { organisationWide: true } : { scopeId: seat.allocatedScopeId });
  if (seat.status !== 'assigned') return seatView(seat);
  return seatView(await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const updated = (await seatRepo.update(db, seatId, { status: 'unassigned', membershipId: null }))!;
    await recordSeatEvent(db, ctx.request, ctx.correlationId, {
      event: 'seat_unassigned', subjectMembershipId: seat.membershipId, detail: { seat_id: seatId },
    });
    return updated;
  }));
}

/** Out of the billable count at the period's end; never reassigned (72.3). */
export async function releaseSeat(deps: AuthDeps, ctx: Context, seatId: string): Promise<SeatView> {
  person(ctx);
  await demand(deps, ctx, 'seat.release', { organisationWide: true });
  const released = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const seat = await seatRepo.findById(db, seatId);
    if (seat === undefined) throw new AppError('not_found', 'no such seat', { code: 'seats.not_found' });
    if (seat.status === 'released') return seat;
    if (seat.status === 'assigned') throw new AppError('conflict', 'unassign the seat before releasing it', { code: 'seats.assigned' });
    const updated = (await seatRepo.update(db, seatId, { status: 'released', releasedAt: new Date().toISOString() }))!;
    // Read first by a reviewer: it reduces capacity and revenue.
    await recordSeatEvent(db, ctx.request, ctx.correlationId, { event: 'seat_released', detail: { seat_id: seatId, plan_tier: seat.planTier } });
    return updated;
  });
  if (released.subscriptionId !== null) {
    await deps.services.call(syncSeatCount, {}, { request: ctx.request, correlationId: ctx.correlationId }).catch((error: unknown) => {
      deps.logger.failure('the provider\'s seat count was not lowered after a release; billing\'s sweep will', error, { event: 'seats.count_sync_failed' });
    });
  }
  return seatView(released);
}

/** A scope's pool, set to a number of seats drawn from its parent's pool (72.5). */
export async function allocatePool(deps: AuthDeps, ctx: Context, input: { scopeId: string; planTier: Seat['planTier']; seats: number }) {
  const by = person(ctx);
  const pool = deps.databases.pool('control');
  const scope = await inTransaction(pool, ctx.request, (db) => scopeRepo.findById(db, input.scopeId), { readOnly: true });
  if (scope === undefined) throw new AppError('not_found', 'no such scope', { code: 'seats.scope_not_found' });
  const parent = scope.parentScopeId;
  await demand(deps, ctx, 'seat.allocate', parent === null ? { organisationWide: true } : { scopeId: parent });
  return inTransaction(pool, ctx.request, async (db) => {
    const current = await seatAllocationRepo.findByScopeIdAndPlanTier(db, { organisationId: ctx.request.organisationId!, scopeId: input.scopeId, planTier: input.planTier });
    const before = current?.seatsAllocated ?? 0;
    const delta = input.seats - before;
    const at = new Date().toISOString();
    if (delta > 0) {
      const free = await seatRepo.countAvailable(db, parent, input.planTier);
      if (free < delta) {
        throw new AppError('bounds', `the parent's pool has ${free} free seats`, { code: 'seats.pool_exceeded', details: { bound: 'seats', limit: free } });
      }
      await seatRepo.movePool(db, parent, input.scopeId, input.planTier, delta, by, at);
    } else if (delta < 0) {
      const free = await seatRepo.countAvailable(db, input.scopeId, input.planTier);
      if (free < -delta) throw new AppError('conflict', 'seats in use stay in the pool: unassign them first', { code: 'seats.pool_in_use' });
      await seatRepo.movePool(db, input.scopeId, parent, input.planTier, -delta, by, at);
    }
    if (current === undefined) {
      await seatAllocationRepo.insert(db, {
        id: uuidv7(), organisationId: ctx.request.organisationId!, scopeId: input.scopeId, seatsAllocated: input.seats, planTier: input.planTier, allocatedBy: by,
      });
    } else {
      await seatAllocationRepo.update(db, current.id, { seatsAllocated: input.seats, allocatedBy: by, allocatedAt: at });
    }
    await recordSeatEvent(db, ctx.request, ctx.correlationId, {
      event: 'seat_pool_allocated', detail: { scope_id: input.scopeId, plan_tier: input.planTier, seats: input.seats, previous: before },
    });
    return { scopeId: input.scopeId, planTier: input.planTier, seatsAllocated: input.seats, available: await seatRepo.countAvailable(db, input.scopeId, input.planTier) };
  });
}
