import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { bounds, invalid, notFound, refusal } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import { childLogger } from '../config/logger.config';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import * as billingRepo from '../repos/billing.repo';
import * as seatRepo from '../repos/seat.repo';
import * as simulationRepo from '../repos/simulation.repo';
import * as organisationRepo from '../repos/organisation.repo';
import { countSeats } from '../models/seat.model';
import {
  allowanceWindow,
  discountFor,
  entitlementsOf,
  nextPeriodEnd,
  priceOf,
  prorate,
  type Price,
  type Term,
} from '../models/billing.model';
import type { Plan } from '../models/organisation.model';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

const log = childLogger('billing');

/**
 * Billing §1–§3 — the subscription, the seats it buys, and the entitlements
 * everything else reads.
 *
 * ── Entitlements are the interface ─────────────────────────────────────────
 *
 * §2: "Nothing reads Stripe." Nothing reads this service either, except through
 * `entitlementsFor`, which answers what an organisation is entitled to now. The
 * subscription is how a self-serve customer got there; a contract is the other
 * way, and the rest of the product cannot tell which.
 *
 * ── A seat is billed from purchase, not from assignment ────────────────────
 *
 * §3. Adding seats charges the rest of the period on the day it happens.
 * Releasing one takes effect at the boundary and refunds nothing: the licence is
 * bought for the period, and a mid-period refund is a discount nobody agreed.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

const MAX_SEATS = 5_000;

export type BillingSummary = {
  subscription: billingRepo.Subscription | null;
  entitlements: billingRepo.Entitlements | null;
  /** What the current configuration costs for a period. */
  price: Price | null;
  seats: { total: number; held: number; reserved: number; free: number };
  /** §5 — the other pool, reported beside the seats it belongs to. */
  simulations: { granted: number; consumed: number; purchasedRemaining: number };
};

/**
 * What an organisation is entitled to now.
 *
 * THE ONE READ EVERYTHING ELSE USES, and it takes a transaction rather than an
 * actor: allowances, metering and the degradation ladder ask this in the middle
 * of their own work, for an organisation rather than for a person.
 */
export async function entitlementsFor(
  db: PoolClient,
  organisationId: string,
): Promise<billingRepo.Entitlements | null> {
  return billingRepo.entitlements(db, organisationId);
}

export async function summary(actor: Actor): Promise<BillingSummary> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'billing.view');

      const subscription = await billingRepo.subscription(db, actor.organisationId);
      const counts = countSeats(await seatRepo.list(db));

      const from = subscription
        ? allowanceWindow(subscription.currentPeriodStart, new Date()).start
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      return {
        subscription,
        entitlements: await entitlementsFor(db, actor.organisationId),
        simulations: await simulationRepo.usageSince(db, { organisationId: actor.organisationId, from }),
        price: subscription
          ? priceOf({ plan: subscription.plan, seats: subscription.seatCount, term: subscription.term })
          : null,
        seats: { total: counts.total, held: counts.held, reserved: counts.reserved, free: counts.free },
      };
    }),
  );
}

/**
 * Start a subscription, or change the plan or term of one.
 *
 * A PLAN CHANGE TAKES EFFECT NOW AND ENTITLES FROM NOW. The allowances of the
 * period already granted are not rewritten by it — §4 grants them per period
 * from what was entitled at the time, which is why entitlements are a history.
 */
export async function subscribe(
  actor: Actor,
  input: { plan: Plan; seats: number; term: Term },
): Promise<BillingSummary> {
  if (input.seats < 1 || input.seats > MAX_SEATS) {
    throw bounds({ message: `A subscription is between 1 and ${MAX_SEATS} seats.`, code: 'bounds.seats' });
  }

  await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'billing.manage');

      const price = priceOf(input);
      if (price.quoted) {
        throw refusal({
          message:
            'That many seats, or that plan, is priced by agreement rather than here. Talk to us and it ' +
            'arrives as a contract.',
          code: 'refusal.quoted_only',
        });
      }

      const existing = await billingRepo.lockSubscription(db, actor.organisationId);
      const now = new Date();
      const discount = discountFor(input.seats);

      const subscription = existing
        ? await billingRepo.updateSubscription(db, {
            id: existing.id,
            plan: input.plan,
            seatCount: input.seats,
            seatCountNext: null,
            term: input.term,
            discountPercent: discount.percent,
          })
        : await billingRepo.createSubscription(db, {
            id: generateId(),
            organisationId: actor.organisationId,
            plan: input.plan,
            seatCount: input.seats,
            term: input.term,
            discountPercent: discount.percent,
            periodStart: now,
            periodEnd: nextPeriodEnd(now, input.term),
          });

      await matchPool(db, { organisationId: actor.organisationId, seats: input.seats, by: actor.membershipId });

      await billingRepo.setEntitlements(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        entitled: entitlementsOf(input.plan, input.seats),
        source: 'subscription',
        sourceId: subscription.id,
      });

      /* The plan on the organisation is what the rest of the product already reads. */
      if (!existing || existing.plan !== input.plan) {
        await organisationRepo.setPlan(db, actor.organisationId, input.plan);
      }

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: existing ? 'plan_changed' : 'subscription_created',
        detail: {
          plan: input.plan,
          previousPlan: existing?.plan ?? null,
          seats: input.seats,
          term: input.term,
          discountPercent: discount.percent,
          amountPence: price.totalPence,
        },
      });
    }),
  );

  return summary(actor);
}

export type SeatChange = {
  seats: number;
  /** Set when seats were added: what the rest of this period costs. */
  chargePence?: number;
  /** Set when seats were released: when the lower count starts being billed. */
  effectiveAt?: Date;
};

/**
 * §3 — buy seats, charged for the rest of the period.
 *
 * THE POOL GROWS WITH THE COUNT. A licence bought and not provisioned is a
 * licence somebody paid for and cannot assign.
 */
export async function addSeats(actor: Actor, count: number): Promise<SeatChange> {
  if (count < 1 || count > 500) {
    throw bounds({ message: 'Add between 1 and 500 seats at a time.', code: 'bounds.seat_batch' });
  }

  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'billing.manage');

      const subscription = await required(db, actor.organisationId);
      const seats = subscription.seatCount + count;
      if (seats > MAX_SEATS) {
        throw bounds({ message: `A subscription is at most ${MAX_SEATS} seats.`, code: 'bounds.seats' });
      }

      const discount = discountFor(seats);
      if (discount.quoted) {
        throw refusal({
          message: 'Past five hundred seats the price is agreed rather than listed. Talk to us.',
          code: 'refusal.quoted_only',
        });
      }

      const at = new Date();

      /*
       * §3 — THE BAND IS THE ORGANISATION'S RESULTING SIZE, NOT THE NUMBER
       * BOUGHT. The ladder is "applied to the seat price", and an organisation's
       * seat price is set by how many seats it has.
       *
       * This priced the ADDITION as though it were the whole subscription:
       * `priceOf({ seats: count })` puts `count` through `discountFor`, so
       * sixty seats added to two hundred were charged at the sixty-seat band.
       * Two lines above, `discountFor(seats)` had already computed the right
       * one and stored it on the subscription — the same function, two
       * different answers, four lines apart.
       *
       * It could only ever overcharge, because `count <= seats` and the ladder
       * only goes one way. A two-hundred-seat organisation adding sixty was
       * charged £1,566 where the published ladder says £1,218, on an invoice
       * line the customer can reproduce and get a different number from.
       */
      const resulting = priceOf({ plan: subscription.plan, seats, term: subscription.term });

      const chargePence = prorate({
        amountPence: resulting.perSeatPence * count,
        at,
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
      });

      await billingRepo.updateSubscription(db, {
        id: subscription.id,
        seatCount: seats,
        discountPercent: discount.percent,
        /* Buying seats cancels a reduction that was waiting: the intent has changed. */
        seatCountNext: null,
      });

      await matchPool(db, { organisationId: actor.organisationId, seats, by: actor.membershipId });
      await reentitle(db, { organisationId: actor.organisationId, subscription: { ...subscription, seatCount: seats } });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'seat_pool_allocated',
        detail: { added: count, seats, amountPence: chargePence, effectiveAt: at.toISOString() },
      });

      return { seats, chargePence };
    }),
  );
}

/**
 * §3 — release seats. The licence count falls at the next boundary.
 *
 * `seat.release`, NOT A MEMBERSHIP PERMISSION. §10: an admin who can offboard a
 * person cannot reduce what the organisation is licensed for.
 *
 * ONLY FREE SEATS. A seat somebody holds is reclaimed from them first; releasing
 * it out from under them would leave a person with no licence and no notice.
 */
export async function releaseSeats(actor: Actor, count: number): Promise<SeatChange> {
  if (count < 1) throw bounds({ message: 'Release at least one seat.', code: 'bounds.seat_batch' });

  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'seat.release');

      const subscription = await required(db, actor.organisationId);
      const scheduled = subscription.seatCountNext ?? subscription.seatCount;
      const seats = scheduled - count;

      /*
       * WHOSE SEAT IT IS COMES FIRST. "One of those is held" is the answer that
       * tells somebody what to do; "keep at least one seat" is true of the same
       * request and says nothing about the person sitting in it.
       */
      const counts = countSeats(await seatRepo.list(db));
      if (counts.free < count) {
        throw bounds({
          message:
            counts.free === 0
              ? 'Every seat is held or reserved. Reclaim one first.'
              : `Only ${counts.free} seat${counts.free === 1 ? ' is' : 's are'} free. Reclaim the others first.`,
          code: 'bounds.seat_occupied',
        });
      }

      if (seats < 1) {
        throw bounds({
          message: 'A subscription keeps at least one seat. Cancel it instead.',
          code: 'bounds.seats',
        });
      }

      /* The pool shrinks now; the bill shrinks at the boundary. */
      for (let removed = 0; removed < count; removed += 1) {
        await seatRepo.retireFree(db, { organisationId: actor.organisationId, by: actor.membershipId });
      }

      await billingRepo.updateSubscription(db, { id: subscription.id, seatCountNext: seats });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'seat_pool_released',
        detail: {
          removed: count,
          seats,
          billedUntil: subscription.currentPeriodEnd.toISOString(),
          effectiveAt: subscription.currentPeriodEnd.toISOString(),
        },
      });

      return { seats, effectiveAt: subscription.currentPeriodEnd };
    }),
  );
}

/**
 * §3 — the period boundary: a scheduled reduction lands, and the next period begins.
 *
 * CALLED BY THE SCHEDULED ROLL, per organisation, under its own tenant. Nothing
 * here charges: what a period costs is Stripe's, and until that is wired this
 * moves the counts and the entitlements so everything downstream is right.
 */
export async function rollPeriod(organisationId: string): Promise<'rolled' | 'skipped'> {
  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction(async (db) => {
      const subscription = await billingRepo.lockSubscription(db, organisationId);
      if (!subscription || subscription.currentPeriodEnd.getTime() > Date.now()) return 'skipped';

      const seats = subscription.seatCountNext ?? subscription.seatCount;
      const start = subscription.currentPeriodEnd;

      const rolled = await billingRepo.updateSubscription(db, {
        id: subscription.id,
        seatCount: seats,
        seatCountNext: null,
        discountPercent: discountFor(seats).percent,
        periodStart: start,
        periodEnd: nextPeriodEnd(start, subscription.term),
      });

      await reentitle(db, { organisationId, subscription: rolled });

      log.info({ organisationId, seats }, 'Subscription period rolled');
      return 'rolled';
    }),
  );
}

/** Subscriptions whose period has run out. Cross-tenant: the scheduled roll's. */
export async function dueToRoll(db: PoolClient): Promise<Array<{ id: string; organisationId: string }>> {
  return billingRepo.dueToRoll(db);
}

/**
 * Start every organisation off entitled, at registration.
 *
 * A NEW ORGANISATION IS SUBSCRIBED FROM THE FIRST MINUTE, on the seats
 * `INCLUDED_SEATS` provisions, so nothing downstream has to treat "no
 * entitlements" as a state of its own.
 */
export async function provision(
  db: PoolClient,
  input: { organisationId: string; plan: Plan; seats: number },
): Promise<void> {
  const now = new Date();

  const subscription = await billingRepo.createSubscription(db, {
    id: generateId(),
    organisationId: input.organisationId,
    plan: input.plan,
    seatCount: input.seats,
    term: 'monthly',
    discountPercent: discountFor(input.seats).percent,
    periodStart: now,
    periodEnd: nextPeriodEnd(now, 'monthly'),
  });

  await billingRepo.setEntitlements(db, {
    id: generateId(),
    organisationId: input.organisationId,
    entitled: entitlementsOf(input.plan, input.seats),
    source: 'subscription',
    sourceId: subscription.id,
    at: now,
  });
}

/**
 * §3 — a seat given up one at a time still lowers the licence count, at the
 * boundary.
 *
 * FOR THE SEAT SCREEN'S OWN RELEASE, which retires a named seat. The pool and
 * the count must not drift apart: a pool smaller than the licence count is
 * somebody paying for seats they cannot assign.
 */
export async function scheduleReduction(
  db: PoolClient,
  input: { organisationId: string; by: number },
): Promise<void> {
  const subscription = await billingRepo.lockSubscription(db, input.organisationId);
  if (!subscription) return;

  const scheduled = subscription.seatCountNext ?? subscription.seatCount;
  const seats = Math.max(1, scheduled - input.by);
  if (seats === scheduled) return;

  await billingRepo.updateSubscription(db, { id: subscription.id, seatCountNext: seats });
}

/* ── Inside ───────────────────────────────────────────────────────────────── */

async function required(db: PoolClient, organisationId: string): Promise<billingRepo.Subscription> {
  const subscription = await billingRepo.lockSubscription(db, organisationId);
  if (!subscription) {
    throw notFound({ message: 'This organisation has no subscription.', code: 'missing.subscription' });
  }
  if (subscription.status === 'cancelled') {
    throw invalid({ message: 'That subscription has been cancelled.', code: 'invalid.subscription_cancelled' });
  }
  return subscription;
}

/** Bring the seat pool up to the licence count. It is never trimmed here. */
async function matchPool(
  db: PoolClient,
  input: { organisationId: string; seats: number; by: string },
): Promise<void> {
  const counts = countSeats(await seatRepo.list(db));
  if (counts.total >= input.seats) return;

  await seatRepo.provision(db, {
    organisationId: input.organisationId,
    count: input.seats - counts.total,
    by: input.by,
  });
}

async function reentitle(
  db: PoolClient,
  input: { organisationId: string; subscription: billingRepo.Subscription },
): Promise<void> {
  await billingRepo.setEntitlements(db, {
    id: generateId(),
    organisationId: input.organisationId,
    entitled: entitlementsOf(input.subscription.plan, input.subscription.seatCount),
    source: 'subscription',
    sourceId: input.subscription.id,
  });
}
