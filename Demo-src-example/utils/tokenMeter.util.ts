/**
 * Charging an operation, in the order the pricing model requires.
 *
 * CONSUMPTION ORDER: ONBOARDING GRANT, THEN PERIOD ALLOWANCE, THEN PURCHASED.
 * Not arbitrary. The grant expires and the allowance resets, so spending the
 * perishable balances first is what stops a customer losing them; purchased
 * tokens never expire, so they are spent last.
 *
 * THE DAILY LIMIT COUNTS ALLOWANCE CONSUMPTION ONLY. That is what makes buying
 * tokens raise the ceiling rather than merely refill it — otherwise a customer
 * who has paid for extra capacity still stops at the same hour of the day.
 *
 * SOME OPERATIONS NEVER CHARGE, AND THAT IS ENFORCED HERE RATHER THAN IN THE UI.
 * A rule implemented in an interface is a rule the API does not have.
 */

export type Operation =
  | 'compile'
  | 'multi_system_compile'
  | 'connector_generation'
  | 'document_extraction'
  /** A web lookup whose context was returned beside an answer, or was the answer. */
  | 'outside_context'
  /** An answer read and written up by the model, or a follow-up question about it (129). */
  | 'answer_reading'
  | 'repair_proposal'
  | 'simulation'
  | 'view_run'
  | 'view_refresh'
  | 'alert_poll'
  | 'cache_hit'
  | 'connection_add'
  | 'refusal';

/**
 * Weights.
 *
 * ZERO IS A REAL VALUE AND IT IS THE PRODUCT PROMISE. Re-running a saved view,
 * refreshing, alert polling, cache hits and adding a connection are free — a
 * customer who is charged for looking at yesterday's answer again stops looking.
 * A refusal is free because charging for a non-answer is indefensible.
 */
/*
 * Billing §4 is the price list, and it reprices three of these: connector
 * generation and document extraction from ten to six, and a repair proposal
 * from five to two. A weight already charged is not rewritten by that — a
 * transaction records what it cost at the time.
 */
const WEIGHTS: Record<Operation, number> = {
  compile: 1,
  /* §4's "advanced compile": a question or a change reaching more than one system. */
  multi_system_compile: 3,
  connector_generation: 6,
  document_extraction: 6,
  /* Priced as a compile: one model call, and a search only when the model chose to run one. */
  outside_context: 1,
  answer_reading: 1,
  repair_proposal: 2,
  simulation: 0, // Metered separately: a different cost base, its own pool.
  view_run: 0,
  view_refresh: 0,
  alert_poll: 0,
  cache_hit: 0,
  connection_add: 0,
  refusal: 0,
};

export interface Balances {
  onboardingGrantRemaining: number;
  allowanceGranted: number;
  allowanceConsumed: number;
  purchasedRemaining: number;
  dailyLimit: number | null;
  /** Allowance consumed today. Purchased spend is deliberately not counted. */
  consumedToday: number;
}

export interface Charge {
  weight: number;
  /** How the weight was split across the three balances. */
  fromGrant: number;
  fromAllowance: number;
  fromPurchased: number;
}

export type ChargeOutcome =
  | { ok: true; charge: Charge }
  | { ok: false; reason: 'daily-limit' | 'exhausted'; shortfall: number };

export function weightOf(operation: Operation): number {
  return WEIGHTS[operation];
}

/**
 * `times` IS FOR ONE PIECE OF WORK THAT DID THE SAME OPERATION SEVERAL TIMES —
 * a file holding four documents. Charged as one split across the balances rather
 * than four, so the daily limit sees the whole of it at once rather than letting
 * the fourth through because the first three fitted.
 */
export function charge(operation: Operation, balances: Balances, times = 1): ChargeOutcome {
  const weight = WEIGHTS[operation] * times;

  // Free operations short-circuit before any limit check: a cache hit must not
  // be refused because the daily limit is reached.
  if (weight === 0) {
    return { ok: true, charge: { weight: 0, fromGrant: 0, fromAllowance: 0, fromPurchased: 0 } };
  }

  const allowanceLeft = Math.max(0, balances.allowanceGranted - balances.allowanceConsumed);
  const total = balances.onboardingGrantRemaining + allowanceLeft + balances.purchasedRemaining;
  if (total < weight) {
    return { ok: false, reason: 'exhausted', shortfall: weight - total };
  }

  const fromGrant = Math.min(balances.onboardingGrantRemaining, weight);
  let outstanding = weight - fromGrant;

  const fromAllowance = Math.min(allowanceLeft, outstanding);
  outstanding -= fromAllowance;

  const fromPurchased = outstanding;

  /*
   * The daily limit is checked AFTER the split and only against the allowance
   * portion. A charge that lands entirely on purchased tokens passes a limit it
   * was never counted toward.
   */
  if (
    balances.dailyLimit !== null &&
    fromAllowance > 0 &&
    balances.consumedToday + fromAllowance > balances.dailyLimit
  ) {
    return {
      ok: false,
      reason: 'daily-limit',
      shortfall: balances.consumedToday + fromAllowance - balances.dailyLimit,
    };
  }

  return { ok: true, charge: { weight, fromGrant, fromAllowance, fromPurchased } };
}
