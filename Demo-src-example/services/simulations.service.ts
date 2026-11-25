import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { bounds, refusal } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import { entitlementsFor } from './billing.service';
import * as billingRepo from '../repos/billing.repo';
import * as simulationRepo from '../repos/simulation.repo';
import * as seatRepo from '../repos/seat.repo';
import { allowanceWindow } from '../models/billing.model';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

/**
 * Billing §5 — simulations, which are their own pool.
 *
 * ── Never drawn from the token pool ────────────────────────────────────────
 *
 * "A shared pool would let a customer buy expensive capability with cheap
 * units." So a simulation is spent from here or not at all, and nothing in this
 * file can reach a token balance.
 *
 * ── The price is not invented here ─────────────────────────────────────────
 *
 * §5 says a top-up is "priced per simulation" and a re-run is "metered at a
 * reduced rate", and gives no number for either. Both are therefore refused as
 * priced by agreement rather than sold at a rate nobody agreed — the same answer
 * §3 gives a seat count past the ladder.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

export type Standing = {
  allowance: simulationRepo.Allowance | null;
  /** Granted less consumed, plus anything bought. */
  available: number;
};

/**
 * What this membership may run, granting the period's allowance the first time
 * it is asked for.
 *
 * NO SEAT, NO ALLOWANCE, as with tokens: an allowance is per seat per period.
 */
export async function standingFor(db: PoolClient, actor: Actor): Promise<Standing> {
  const entitlements = await entitlementsFor(db, actor.organisationId);
  const subscription = await billingRepo.subscription(db, actor.organisationId);
  const holdsSeat = await seatRepo.heldBy(db, actor.membershipId);

  if (!entitlements || !subscription || !holdsSeat) return { allowance: null, available: 0 };

  const window = allowanceWindow(subscription.currentPeriodStart, new Date());

  const { allowance, granted } = await simulationRepo.allowanceFor(db, {
    membershipId: actor.membershipId,
    organisationId: actor.organisationId,
    periodStart: window.start,
    periodEnd: window.end,
    granted: entitlements.simulationsPerSeat,
  });

  if (granted && allowance.granted > 0) {
    await writeAudit(db, {
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      event: 'allowance_granted',
      detail: {
        kind: 'simulations',
        granted: allowance.granted,
        periodStart: window.start.toISOString(),
        periodEnd: window.end.toISOString(),
      },
    });
  }

  return {
    allowance,
    available: Math.max(0, allowance.granted - allowance.consumed) + allowance.purchasedRemaining,
  };
}

export async function standing(actor: Actor): Promise<Standing> {
  return runWithTenant(tenantOf(actor), () => withTransaction((db) => standingFor(db, actor)));
}

/**
 * Spend one simulation, or refuse.
 *
 * NOTHING CALLS THIS YET, and that is the point of building it now: when
 * simulations arrive, the pool they come out of already exists, so the easiest
 * thing to write will not be the one that spends tokens.
 *
 * A RE-RUN IS CHARGED, at a reduced rate §5 does not put a number on. Until it
 * does, `rerun` is refused rather than given away: re-running recomputes against
 * current data and costs what a first run costs to serve.
 */
export async function spend(actor: Actor, input: { rerun?: boolean } = {}): Promise<void> {
  if (input.rerun) {
    throw refusal({
      message: 'Re-running a saved simulation is priced by agreement. Talk to us.',
      code: 'refusal.quoted_only',
    });
  }

  await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const current = await standingFor(db, actor);

      if (!current.allowance || current.available < 1) {
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'allowance_exhausted',
          detail: { kind: 'simulations', weight: 1 },
        });

        throw bounds({
          message:
            current.allowance === null
              ? 'Simulations are not included on this plan.'
              : 'Your simulations for this period have run out.',
          code: 'bounds.simulations_exhausted',
          detail: { shortfall: 1 },
        });
      }

      await simulationRepo.consume(db, {
        membershipId: actor.membershipId,
        periodStart: current.allowance.periodStart,
        /* The allowance first; what was bought does not expire, so it waits. */
        fromAllowance: current.allowance.consumed < current.allowance.granted,
      });
    }),
  );
}

/**
 * §5 — buying simulations, which has no listed price.
 *
 * REFUSED RATHER THAN GUESSED. Selling at an invented rate is worse than saying
 * it is a conversation: the rate would appear on an invoice as though somebody
 * had agreed it.
 */
export async function purchase(actor: Actor): Promise<never> {
  await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'tokens.purchase');
    }),
  );

  throw refusal({
    message: 'Simulations are sold by agreement rather than at a listed price. Talk to us.',
    code: 'refusal.quoted_only',
  });
}
