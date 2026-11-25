import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { bounds, invalid } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import { childLogger } from '../config/logger.config';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf, can } from './authorisation.service';
import { entitlementsFor } from './billing.service';
import * as organisationRepo from '../repos/organisation.repo';
import * as tokenRepo from '../repos/token.repo';
import * as billingRepo from '../repos/billing.repo';
import * as seatRepo from '../repos/seat.repo';
import { charge as meter, weightOf, type Operation } from '../utils/tokenMeter.util';
import { allowanceWindow, ONBOARDING_GRANT, packsFor, TOKEN_PACK } from '../models/billing.model';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

const log = childLogger('tokens');

/**
 * Billing §4 — what an operation costs, and which balance it comes out of.
 *
 * ── Charged after it worked, refused before it starts ──────────────────────
 *
 * A refusal, a rephrase and a cache hit are never metered, so nothing is
 * charged until an operation has produced what it was asked for. That leaves
 * one hole — a model call made by somebody with nothing left — which `afford`
 * closes: it refuses first, on the most an operation of that kind can cost, and
 * `spend` then charges what it actually cost.
 *
 * ── The daily limit is about the allowance, not about the money ────────────
 *
 * §4: "The daily limit checks against allowance consumption only, so purchased
 * tokens raise the ceiling." Somebody who has bought tokens has decided what
 * their day is worth; the limit exists so a runaway loop cannot spend a month's
 * allowance in an afternoon.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

export type Standing = {
  allowance: tokenRepo.Allowance | null;
  balances: tokenRepo.Balances;
  consumedToday: number;
  /** Everything spendable now: grant, what is left of the allowance, and purchased. */
  available: number;
};

/**
 * What this membership may spend, granting the period's allowance and the
 * onboarding grant if they have not been granted yet.
 */
async function standingFor(db: PoolClient, actor: Actor): Promise<Standing> {
  const entitlements = await entitlementsFor(db, actor.organisationId);
  const subscription = await billingRepo.subscription(db, actor.organisationId);

  const { balances, granted: grantGiven } = await tokenRepo.balancesFor(db, {
    membershipId: actor.membershipId,
    organisationId: actor.organisationId,
    grant: ONBOARDING_GRANT,
  });

  if (grantGiven) {
    await writeAudit(db, {
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      event: 'allowance_granted',
      detail: { kind: 'onboarding', granted: ONBOARDING_GRANT },
    });
  }

  /*
   * NO SEAT, NO ALLOWANCE. An allowance is per seat per period (§4), and a
   * membership holding no licence has not been given one. The onboarding grant
   * is separate and is already theirs.
   */
  const holdsSeat = await seatRepo.heldBy(db, actor.membershipId);

  if (!entitlements || !subscription || !holdsSeat) {
    return {
      allowance: null,
      balances,
      consumedToday: await tokenRepo.consumedToday(db, actor.membershipId),
      available: balances.grantRemaining + balances.purchasedRemaining,
    };
  }

  const window = allowanceWindow(subscription.currentPeriodStart, new Date());

  /*
   * BILLING §2 — THE PLAN IS THE CEILING AND THE ORGANISATION MAY ONLY LOWER
   * IT. The smaller of the two wins, so a local setting can hold people to less
   * than was bought and can never buy capability. On Enterprise the plan sets
   * no limit at all, which is the case this exists for: the plan with the most
   * to lose from a runaway loop was the one with no brake.
   */
  const organisation = await organisationRepo.findById(db, actor.organisationId);
  const dailyLimit = leastOf(entitlements.dailyTokenLimit, organisation?.dailyTokenLimit ?? null);

  const { allowance, granted } = await tokenRepo.allowanceFor(db, {
    membershipId: actor.membershipId,
    organisationId: actor.organisationId,
    periodStart: window.start,
    periodEnd: window.end,
    granted: entitlements.tokensPerSeat,
    dailyLimit,
  });

  if (granted) {
    await writeAudit(db, {
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      event: 'allowance_granted',
      detail: {
        kind: 'period',
        granted: allowance.granted,
        periodStart: window.start.toISOString(),
        periodEnd: window.end.toISOString(),
      },
    });
  }

  return {
    allowance,
    balances,
    consumedToday: await tokenRepo.consumedToday(db, actor.membershipId),
    available: balances.grantRemaining + balances.purchasedRemaining + Math.max(0, allowance.granted - allowance.consumed),
  };
}

const balancesOf = (standing: Standing) => ({
  onboardingGrantRemaining: standing.balances.grantRemaining,
  allowanceGranted: standing.allowance?.granted ?? 0,
  allowanceConsumed: standing.allowance?.consumed ?? 0,
  purchasedRemaining: standing.balances.purchasedRemaining,
  dailyLimit: standing.allowance?.dailyLimit ?? null,
  consumedToday: standing.consumedToday,
});

function refuse(reason: 'daily-limit' | 'exhausted', shortfall: number): never {
  throw bounds({
    message:
      reason === 'daily-limit'
        ? 'That would pass the daily limit on your allowance. It resets tomorrow, and bought tokens are not limited.'
        : 'Your tokens have run out. Buy more, or wait for next month’s allowance.',
    code: reason === 'daily-limit' ? 'bounds.daily_limit' : 'bounds.tokens_exhausted',
    detail: { shortfall },
  });
}

/**
 * Refuse before an expensive operation starts.
 *
 * `most` IS THE MOST IT COULD COST, not what it will. A question that turns out
 * to reach three systems costs three; checking for one and charging three would
 * let somebody with one token left make a call nobody can pay for.
 */
/** Null is "no limit from this quarter", so it never tightens and never loosens. */
const leastOf = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);

export async function afford(actor: Actor, most: Operation): Promise<void> {
  const first = await check(actor, most);
  if (first.ok) return;

  /*
   * §4 — THE TOP-UP IS TRIED ONCE, AND ONLY WHERE IT WAS SWITCHED ON. A daily
   * limit is never topped up past: buying tokens raises the ceiling for the
   * operations that come out of the purchased balance, and the limit is about
   * the allowance, so retrying the same refusal would just buy tokens nobody
   * asked for.
   */
  if (first.reason === 'exhausted' && (await topUpIfEnabled(actor))) {
    const second = await check(actor, most);
    if (second.ok) return;
    await announced(actor, second.reason, weightOf(most));
    refuse(second.reason, second.shortfall);
  }

  await announced(actor, first.reason, weightOf(most));
  refuse(first.reason, first.shortfall);
}

async function check(
  actor: Actor,
  most: Operation,
): Promise<{ ok: true } | { ok: false; reason: 'daily-limit' | 'exhausted'; shortfall: number }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const outcome = meter(most, balancesOf(await standingFor(db, actor)));
      return outcome.ok ? { ok: true as const } : { ok: false as const, reason: outcome.reason, shortfall: outcome.shortfall };
    }),
  );
}

async function announced(actor: Actor, reason: 'daily-limit' | 'exhausted', weight: number): Promise<void> {
  await runWithTenant(tenantOf(actor), () => withTransaction((db) => announce(db, actor, reason, weight)));
}

/**
 * Charge for an operation that produced something.
 *
 * NEVER THROWS FOR LACK OF TOKENS WHERE `afford` HAS ALREADY PASSED. The work is
 * done and the customer has it; if the balance has moved under a concurrent
 * charge the shortfall is taken from the allowance, which goes no further
 * negative than one operation, and the next `afford` refuses.
 */
export async function spend(
  actor: Actor,
  operation: Operation,
  input: { correlationId?: string; times?: number } = {},
): Promise<{ weight: number }> {
  /* `times` is for an operation that happened more than once in one piece of
     work — a file holding four documents is four extractions, at six each. */
  const times = input.times ?? 1;
  const weight = weightOf(operation) * times;
  if (weight === 0) return { weight: 0 };

  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const standing = await standingFor(db, actor);
      await tokenRepo.lockBalances(db, actor.membershipId);
      if (standing.allowance) {
        await tokenRepo.lockAllowance(db, {
          membershipId: actor.membershipId,
          periodStart: standing.allowance.periodStart,
        });
      }

      const outcome = meter(operation, balancesOf(standing), times);

      const parts = outcome.ok
        ? outcome.charge
        : /* Overspent by a race: charged to the allowance, and refused next time. */
          { weight, fromGrant: 0, fromAllowance: weight, fromPurchased: 0 };

      await tokenRepo.record(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        operation,
        correlationId: input.correlationId ?? generateId(),
        parts: [
          { source: 'grant', weight: parts.fromGrant },
          { source: 'allowance', weight: parts.fromAllowance },
          { source: 'purchased', weight: parts.fromPurchased },
        ],
      });

      if (parts.fromGrant > 0 || parts.fromPurchased > 0) {
        await tokenRepo.spendBalances(db, {
          membershipId: actor.membershipId,
          fromGrant: parts.fromGrant,
          fromPurchased: parts.fromPurchased,
        });
      }

      if (parts.fromAllowance > 0 && standing.allowance) {
        await tokenRepo.consumeAllowance(db, {
          membershipId: actor.membershipId,
          periodStart: standing.allowance.periodStart,
          tokens: parts.fromAllowance,
        });
      }

      log.debug({ operation, weight }, 'Tokens charged');
      return { weight };
    }),
  );
}

/** Said once when a limit bites, so "how often does this happen" is answerable. */
async function announce(
  db: PoolClient,
  actor: Actor,
  reason: 'daily-limit' | 'exhausted',
  weight: number,
): Promise<void> {
  await writeAudit(db, {
    organisationId: actor.organisationId,
    membershipId: actor.membershipId,
    userId: null,
    event: reason === 'daily-limit' ? 'daily_limit_reached' : 'allowance_exhausted',
    detail: { weight },
  });
}

/* ── Buying ───────────────────────────────────────────────────────────────── */

export type Purchase = { tokens: number; pricePence: number; purchasedRemaining: number };

/**
 * §4 — £20 per 100 tokens, sold in packs, never expiring.
 *
 * ROUNDED UP TO A PACK, AND THE ANSWER SAYS WHAT WAS BOUGHT. Asking for 150
 * tokens buys 200; quietly selling 150 at the pack rate is a different price per
 * token from the one published.
 */
export async function purchase(actor: Actor, tokens: number): Promise<Purchase> {
  if (tokens < 1 || tokens > 100_000) {
    throw invalid({ message: 'Buy between 1 and 100,000 tokens.', code: 'invalid.token_quantity' });
  }

  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'tokens.purchase');
      return buy(db, actor, { tokens, auto: false });
    }),
  );
}

async function buy(
  db: PoolClient,
  actor: Actor,
  input: { tokens: number; auto: boolean },
): Promise<Purchase> {
  const pack = packsFor(input.tokens);

  await tokenRepo.balancesFor(db, {
    membershipId: actor.membershipId,
    organisationId: actor.organisationId,
    grant: ONBOARDING_GRANT,
  });
  await tokenRepo.addPurchased(db, { membershipId: actor.membershipId, tokens: pack.tokens });

  await tokenRepo.recordPurchase(db, {
    id: generateId(),
    organisationId: actor.organisationId,
    membershipId: actor.membershipId,
    kind: 'tokens',
    quantity: pack.tokens,
    amountPence: pack.pricePence,
    auto: input.auto,
  });

  await writeAudit(db, {
    organisationId: actor.organisationId,
    membershipId: actor.membershipId,
    userId: null,
    event: 'tokens_purchased',
    detail: { quantity: pack.tokens, amountPence: pack.pricePence, auto: input.auto },
  });

  const balances = await tokenRepo.lockBalances(db, actor.membershipId);
  return { tokens: pack.tokens, pricePence: pack.pricePence, purchasedRemaining: balances?.purchasedRemaining ?? 0 };
}

/**
 * §4 — "Auto top-up is opt-in, never default."
 *
 * WITH IT OFF, EXHAUSTION REFUSES AND SAYS SO rather than billing silently.
 * That is the whole point of the setting, so it is a deliberate act with its own
 * audit row and its own permission.
 */
export async function setAutoTopUp(actor: Actor, enabled: boolean): Promise<{ autoTopUp: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'tokens.purchase');

      await tokenRepo.balancesFor(db, {
        membershipId: actor.membershipId,
        organisationId: actor.organisationId,
        grant: ONBOARDING_GRANT,
      });
      await tokenRepo.setAutoTopUp(db, { membershipId: actor.membershipId, enabled });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'auto_topup_toggled',
        detail: { enabled, packTokens: TOKEN_PACK.tokens, packPricePence: TOKEN_PACK.pricePence },
      });

      return { autoTopUp: enabled };
    }),
  );
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

export type Usage = Standing & {
  /** §2 — what the plan allows a person in a day, what this organisation allows, and which is in force. */
  limits?: { plan: number | null; organisation: number | null; effective: number | null };
  /** What the organisation has spent this period, per operation. Needs `billing.view`. */
  organisation?: Array<{ operation: string; tokens: number }>;
  /** What it bought this period, automatic top-ups marked as such. Needs `billing.view`. */
  purchases?: Awaited<ReturnType<typeof tokenRepo.purchasesSince>>;
};

/**
 * What somebody has left.
 *
 * THEIR OWN WITHOUT ASKING FOR PERMISSION. An allowance is a limit on the person
 * using it, and hiding it behind `billing.view` would leave most people unable
 * to see why they had been refused. The organisation's spend is the billing read.
 */
export async function usage(actor: Actor): Promise<Usage> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const standing = await standingFor(db, actor);
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);

      if (!can(authority, 'billing.view')) return standing;

      const subscription = await billingRepo.subscription(db, actor.organisationId);
      const from = subscription
        ? allowanceWindow(subscription.currentPeriodStart, new Date()).start
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      /*
       * BOTH LIMITS, NOT ONLY THE ONE IN FORCE. A page that shows "20 a day"
       * cannot say whether that is what was bought or what this organisation
       * chose, and the difference is the whole of what there is to decide.
       */
      const entitled = await billingRepo.entitlements(db, actor.organisationId);
      const organisation = await organisationRepo.findById(db, actor.organisationId);

      return {
        ...standing,
        limits: {
          plan: entitled?.dailyTokenLimit ?? null,
          organisation: organisation?.dailyTokenLimit ?? null,
          effective: leastOf(entitled?.dailyTokenLimit ?? null, organisation?.dailyTokenLimit ?? null),
        },
        organisation: await tokenRepo.spendByOperation(db, { organisationId: actor.organisationId, from }),
        purchases: await tokenRepo.purchasesSince(db, { organisationId: actor.organisationId, from }),
      };
    }),
  );
}

/**
 * §4 — the last thing tried when an operation cannot be afforded.
 *
 * ONLY WHERE IT IS SWITCHED ON. This is called by the metering wrapper, not by
 * a caller deciding for itself: the choice was made once, deliberately, and is
 * read from the balance rather than passed in.
 */
export async function topUpIfEnabled(actor: Actor): Promise<boolean> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const balances = await tokenRepo.lockBalances(db, actor.membershipId);
      if (!balances?.autoTopUp) return false;

      await buy(db, actor, { tokens: TOKEN_PACK.tokens, auto: true });
      return true;
    }),
  );
}

/**
 * BILLING §2 — the organisation's own daily ceiling.
 *
 * `billing.manage`, AND IT IS SAFE THERE BECAUSE IT CANNOT BUY ANYTHING. The
 * plan remains the ceiling and this can only lower it, so the worst somebody
 * can do with it is hold their own people to less than was paid for — which is
 * a decision the people paying are entitled to make.
 *
 * NULL FOLLOWS THE PLAN AGAIN. On Standard and Business that restores twenty
 * or forty a day; on Enterprise, where the plan sets none, it removes the brake.
 */
export async function setDailyLimit(actor: Actor, limit: number | null): Promise<{ dailyLimit: number | null }> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'billing.manage');

        if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
          throw invalid({ message: 'A daily limit is a whole number of tokens, or nothing at all.', code: 'invalid.daily_limit' });
        }

        const previous = (await organisationRepo.findById(db, actor.organisationId))?.dailyTokenLimit ?? null;
        await organisationRepo.setDailyTokenLimit(db, actor.organisationId, limit);

        await writeAudit(db, {
          event: 'daily_limit_set',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          /* `from`/`to` rather than previous/value: the latter is the name a
             standing check reserves for a captured customer value, and this is
             a setting. Same words the sharing policy's change uses. */
          detail: { from: previous, to: limit },
        });

        return { dailyLimit: limit };
      }),
  );
}

