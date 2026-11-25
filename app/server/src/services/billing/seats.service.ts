// Seat counts and the payment provider (contracts/billing/seats.contract.ts; spec 72.2, 74.5).
//
// The subscription's quantity at the provider is the billed seat count. Silo moves it in two
// directions and mirrors the result at once, as the webhook would (applySubscription), so seats
// and the entitlement follow without waiting for the event:
// - buying seats raises it, prorated to the rest of the period and invoiced now (72.2: "mid-
//   period addition prorates");
// - releasing seats lowers it to the seats still billable, with no proration: the current
//   invoice is neither reduced nor refunded, and the next bills the lower count.
// The sweep corrects any live subscription whose count is above its billable seats (a release
// whose provider call failed). An Enterprise contract's seats are the contract's, not the
// provider's: none of this applies to them.

import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Subscription } from '../../models/billing/index.model.ts';
import { contractRepo, seatRepo, subscriptionRepo } from '../../repos/billing/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { requirePermission, type BillingDeps } from './deps.service.ts';
import { applySubscription } from './webhook.service.ts';

/** 500 seats and above are quoted (72.1). */
const QUOTED_FROM = 500;

export function createSeatSync(deps: BillingDeps) {
  const control = deps.databases.pool('control');

  async function billable(organisationId: string): Promise<{ subscription: Subscription | undefined; billableSeats: number }> {
    return inTransaction(control, { organisationId }, async (db) => {
      const subscription = await subscriptionRepo.findLive(db, organisationId);
      return { subscription, billableSeats: subscription === undefined ? 0 : (await seatRepo.liveForSubscription(db, subscription.id)).length };
    }, { readOnly: true });
  }

  /** Sets the provider's count and mirrors what it answers. */
  async function setCount(subscription: Subscription, quantity: number, prorate: boolean, key: string, correlationId: string): Promise<void> {
    const provider = await deps.payments.setSubscriptionQuantity(subscription.stripeSubscriptionId, quantity, prorate, key);
    await applySubscription(deps, provider, key, correlationId, deps.logger);
  }

  async function sync(organisationId: string, correlationId: string): Promise<{ seatCount: number | null; changed: boolean }> {
    const { subscription, billableSeats } = await billable(organisationId);
    if (subscription === undefined) return { seatCount: null, changed: false };
    const target = Math.max(1, billableSeats);
    if (subscription.seatCount <= target) return { seatCount: subscription.seatCount, changed: false };
    await setCount(subscription, target, false, `seat-count:${subscription.id}:${subscription.seatCount}:${target}`, correlationId);
    return { seatCount: target, changed: true };
  }

  return {
    sync,

    /** billing.manage: more seats on the self-serve subscription, prorated and invoiced now. */
    async buy(ctx: HandlerContext, seats: number): Promise<{ seatCount: number; added: number }> {
      await requirePermission(deps, ctx, 'billing.manage');
      const organisationId = ctx.request.organisationId!;
      const { subscription, contract } = await inTransaction(control, ctx.request, async (db) => ({
        subscription: await subscriptionRepo.findLive(db, organisationId), contract: await contractRepo.findActive(db, organisationId),
      }), { readOnly: true });
      if (contract !== undefined) throw new AppError('conflict', 'an Enterprise contract\'s seats come with the contract', { code: 'billing.contract_active' });
      if (subscription === undefined) throw new AppError('conflict', 'the organisation has no subscription; start one first', { code: 'billing.no_subscription' });
      const quantity = subscription.seatCount + seats;
      if (quantity >= QUOTED_FROM) {
        throw new AppError('validation', `${QUOTED_FROM} seats and above are quoted: talk to Silo`, { code: 'billing.seats_quoted', details: { limit: QUOTED_FROM - 1 } });
      }
      await setCount(subscription, quantity, true, `seats:${organisationId}:${ctx.idempotencyKey}`, ctx.correlationId);
      return { seatCount: quantity, added: seats };
    },

    /** Every live subscription counted above its billable seats, corrected. */
    async sweep(correlationId: string, batch = 200): Promise<number> {
      const drifted = await inTransaction(control, {}, (db) => subscriptionRepo.seatDrift(db, batch), { readOnly: true });
      let corrected = 0;
      for (const organisationId of drifted) {
        try {
          if ((await sync(organisationId, correlationId)).changed) corrected += 1;
        } catch (error) {
          deps.logger.failure('a subscription\'s seat count was not corrected; the next sweep retries', error, { event: 'billing.seat_sync_failed', organisationId });
        }
      }
      return corrected;
    },
  };
}

export type SeatSync = ReturnType<typeof createSeatSync>;
