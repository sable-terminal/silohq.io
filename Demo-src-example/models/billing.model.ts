import type { Plan } from './organisation.model';

/**
 * Billing §1–§3 — what a plan includes, what a seat costs, and what changing
 * either does mid-period.
 *
 * ── Arithmetic, in one place, with no database ─────────────────────────────
 *
 * Every figure a customer is shown or charged comes from here: the ladder, the
 * annual terms, the proration and what a plan entitles. It takes numbers and
 * returns numbers, so the pricing can be checked against the contract without a
 * subscription existing.
 *
 * ── Pence, never pounds ────────────────────────────────────────────────────
 *
 * Money is integers throughout. A 10% discount on £29 is £26.10, and a floating
 * point £26.099999 that rounds differently on the invoice and in the preview is
 * how a customer stops trusting both.
 */

export type Term = 'monthly' | 'annual';

export type PlanTerms = {
  /** Null on enterprise: the price is quoted, not listed. */
  seatPricePence: number | null;
  tokensPerSeat: number;
  simulationsPerSeat: number;
  /** Null means no daily limit, which only a contract sets. */
  dailyTokenLimit: number | null;
  storageIncludedBytes: number;
  /*
   * Automations §7 — how often a scheduled check may run. Invented, because §7
   * says "per plan" and names no numbers; kept in entitlements so a contract
   * can set it per customer without a deploy.
   */
  minimumIntervalMinutes: number;
  capabilities: readonly string[];
};

/**
 * §4 and §5 — allowances are per seat per period and are never discounted.
 *
 * STORAGE INCLUDES NOTHING ON A LISTED PLAN. §6 bills Siloes at cost plus 10%
 * from the first byte unless something includes some; a contract may, and the
 * generous default that would otherwise sit here is a cost that accrues whether
 * or not the product is used.
 */
export const PLAN_TERMS: Record<Plan, PlanTerms> = {
  standard: {
    seatPricePence: 2_900,
    tokensPerSeat: 300,
    simulationsPerSeat: 0,
    dailyTokenLimit: 20,
    storageIncludedBytes: 0,
    minimumIntervalMinutes: 60,
    capabilities: [],
  },
  business: {
    seatPricePence: 7_900,
    tokensPerSeat: 1_000,
    simulationsPerSeat: 5,
    dailyTokenLimit: 40,
    storageIncludedBytes: 0,
    minimumIntervalMinutes: 15,
    capabilities: ['simulations'],
  },
  /* Quoted, and until a contract exists it entitles nothing by itself. */
  enterprise: {
    seatPricePence: null,
    tokensPerSeat: 0,
    simulationsPerSeat: 0,
    dailyTokenLimit: null,
    storageIncludedBytes: 0,
    minimumIntervalMinutes: 5,
    capabilities: ['simulations'],
  },
};

/**
 * §3 — the ladder, applied to the seat price and to nothing else.
 *
 * `quoted` IS NOT A DISCOUNT OF ITS OWN. Past five hundred seats the price is a
 * conversation, and returning some percentage here would let the self-serve path
 * sell a deal nobody agreed.
 *
 * THE QUOTED BAND CARRIED 30% UNTIL SOMEBODY READ IT AGAINST THAT PARAGRAPH.
 * Every self-serve entry point refuses a quoted band before it prices anything,
 * so the number was unreachable from the API — but `summary` and `rollPeriod`
 * call `discountFor` and `priceOf` with no such check, so an organisation
 * provisioned by any other route was quietly priced at thirty per cent off a
 * deal nobody had agreed. Nought is the honest figure: there is no listed
 * discount at this size, which is what `quoted` means.
 */
export const SEAT_DISCOUNTS: ReadonlyArray<{ from: number; percent: number; quoted?: boolean }> = [
  { from: 500, percent: 0, quoted: true },
  { from: 250, percent: 30 },
  { from: 100, percent: 20 },
  { from: 25, percent: 10 },
  { from: 1, percent: 0 },
];

export function discountFor(seats: number): { percent: number; quoted: boolean } {
  const band = SEAT_DISCOUNTS.find((one) => seats >= one.from) ?? { from: 1, percent: 0 };
  return { percent: band.percent, quoted: Boolean('quoted' in band && band.quoted) };
}

/** §3 — annual: two months free, then a further 20% per seat. */
export const ANNUAL_MONTHS_CHARGED = 10;
export const ANNUAL_FURTHER_DISCOUNT = 20;

export type Price = {
  /** What one seat costs for the period, after every discount. */
  perSeatPence: number;
  /** What the whole period costs. */
  totalPence: number;
  seats: number;
  term: Term;
  seatDiscountPercent: number;
  /** Whether this configuration is past the self-serve ladder and has to be quoted. */
  quoted: boolean;
};

const applyPercent = (pence: number, percent: number) => Math.round((pence * (100 - percent)) / 100);

/**
 * §3 — what a subscription costs for one period.
 *
 * ORDER MATTERS AND IS THE CONTRACT'S. The ladder comes off the list price;
 * annual then charges ten of twelve months and takes a further fifth off. Doing
 * it the other way round produces a different number, and the one a customer was
 * shown has to be the one on the invoice.
 */
export function priceOf(input: { plan: Plan; seats: number; term: Term }): Price {
  const list = PLAN_TERMS[input.plan].seatPricePence;
  const discount = discountFor(input.seats);

  /*
   * A QUOTED SIZE HAS NO PRICE, exactly as an enterprise plan has none. Falling
   * through to the arithmetic would produce a total from a ladder that stops
   * before this band, which is a figure somebody could put on an invoice.
   */
  if (list === null || discount.quoted) {
    return {
      perSeatPence: 0,
      totalPence: 0,
      seats: input.seats,
      term: input.term,
      seatDiscountPercent: discount.percent,
      quoted: true,
    };
  }

  const laddered = applyPercent(list, discount.percent);

  const perSeatPence =
    input.term === 'annual'
      ? applyPercent(laddered * ANNUAL_MONTHS_CHARGED, ANNUAL_FURTHER_DISCOUNT)
      : laddered;

  return {
    perSeatPence,
    totalPence: perSeatPence * input.seats,
    seats: input.seats,
    term: input.term,
    seatDiscountPercent: discount.percent,
    quoted: discount.quoted,
  };
}

/**
 * §3 — what seats added mid-period cost for the rest of it.
 *
 * TO THE DAY, AND NEVER NEGATIVE. A change on the last day of the period costs
 * a day; one made after the period should have rolled costs nothing rather than
 * crediting the customer for time that has passed.
 */
export function prorate(input: {
  amountPence: number;
  at: Date;
  periodStart: Date;
  periodEnd: Date;
}): number {
  const period = input.periodEnd.getTime() - input.periodStart.getTime();
  if (period <= 0) return 0;

  const remaining = Math.min(Math.max(input.periodEnd.getTime() - input.at.getTime(), 0), period);
  return Math.round((input.amountPence * remaining) / period);
}

export type Entitled = {
  seats: number;
  tokensPerSeat: number;
  simulationsPerSeat: number;
  dailyTokenLimit: number | null;
  storageIncludedBytes: number;
  /** Automations §7 — the floor on how often a check may be scheduled. */
  minimumIntervalMinutes: number;
  capabilities: string[];
};

/**
 * §2 — what a subscription entitles.
 *
 * ALLOWANCES ARE NOT DISCOUNTED WITH THE SEAT PRICE. Five hundred seats buy five
 * hundred seats' worth of tokens at the same rate per seat; the ladder is about
 * what a seat costs, not what it includes.
 */
export function entitlementsOf(plan: Plan, seats: number): Entitled {
  const terms = PLAN_TERMS[plan];

  return {
    seats,
    tokensPerSeat: terms.tokensPerSeat,
    simulationsPerSeat: terms.simulationsPerSeat,
    dailyTokenLimit: terms.dailyTokenLimit,
    storageIncludedBytes: terms.storageIncludedBytes,
    minimumIntervalMinutes: terms.minimumIntervalMinutes,
    capabilities: [...terms.capabilities],
  };
}

/** The period after this one, in whole months from its start. */
export function nextPeriodEnd(start: Date, term: Term): Date {
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + (term === 'annual' ? 12 : 1));
  return end;
}

/* ── Allowance periods ────────────────────────────────────────────────────── */

/**
 * §4 — allowances are monthly, whatever the subscription's term.
 *
 * ANCHORED TO THE SUBSCRIPTION'S OWN DAY, not to the calendar month. Somebody
 * who subscribed on the 20th gets their allowance on the 20th; a calendar month
 * would give an annual customer twelve allowances on the 1st and one short
 * first month nobody agreed to.
 *
 * A DAY THAT DOES NOT EXIST IN A MONTH LANDS ON ITS LAST. The 31st becomes the
 * 30th in April and the 28th in February, and the window still meets the next
 * one exactly.
 */
export function allowanceWindow(anchor: Date, now: Date): { start: Date; end: Date } {
  const day = anchor.getUTCDate();

  const on = (year: number, month: number): Date => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(
      Date.UTC(
        year,
        month,
        Math.min(day, lastDay),
        anchor.getUTCHours(),
        anchor.getUTCMinutes(),
        anchor.getUTCSeconds(),
        anchor.getUTCMilliseconds(),
      ),
    );
  };

  let start = on(now.getUTCFullYear(), now.getUTCMonth());
  if (start.getTime() > now.getTime()) start = on(now.getUTCFullYear(), now.getUTCMonth() - 1);
  if (start.getTime() < anchor.getTime()) start = new Date(anchor);

  const next = on(start.getUTCFullYear(), start.getUTCMonth() + 1);
  return { start, end: next.getTime() > start.getTime() ? next : on(start.getUTCFullYear(), start.getUTCMonth() + 2) };
}

/** §4 — £20 per 100 tokens, roughly double the in-plan rate, so the plan stays the better deal. */
export const TOKEN_PACK = { tokens: 100, pricePence: 2_000 } as const;

/** §4 — what a new organisation is given on first activation, outside the allowance. */
export const ONBOARDING_GRANT = 200;

export function packsFor(tokens: number): { packs: number; tokens: number; pricePence: number } {
  const packs = Math.ceil(tokens / TOKEN_PACK.tokens);
  return { packs, tokens: packs * TOKEN_PACK.tokens, pricePence: packs * TOKEN_PACK.pricePence };
}
