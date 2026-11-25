/**
 * Billing §6 — what a Silo costs to hold and to ask questions of.
 *
 * ── The only place cost is disclosed, so it is the only place it is decided ─
 *
 * "10% over cost is a claim that only means something if the cost is visible."
 * The rates below are what the provider charges us; the margin is a single
 * number applied to them, and both travel with every measurement so a line from
 * last year can be read without knowing what today's rates are.
 *
 * ── Rates are configuration, not truth ─────────────────────────────────────
 *
 * A provider's price list changes. These are the defaults a deployment starts
 * with, overridable by environment, and every measurement records the rates it
 * used — so changing them re-prices the future and nothing else.
 */

export type Residency = 'uk' | 'eu' | 'unrestricted';

export type Rates = {
  /** Object storage: what a gigabyte held for a month costs, in pence. */
  objectPerGbMonthPence: number;
  /** Row store: a gigabyte held for a month, in pence. */
  rowsPerGbMonthPence: number;
  /** Query: a terabyte scanned, in pence. */
  scannedPerTbPence: number;
};

/**
 * §6 — "Sovereign carries the regional rate."
 *
 * A REGIONAL ENDPOINT COSTS MORE THAN A GLOBAL ONE, and the difference is the
 * customer's, not ours: the plus 10% applies to their actual rate rather than
 * to a blended one that quietly subsidises them with everybody else's.
 */
export const RATE_CARD: Record<Residency, Rates> = {
  unrestricted: { objectPerGbMonthPence: 2, rowsPerGbMonthPence: 2, scannedPerTbPence: 500 },
  eu: { objectPerGbMonthPence: 2, rowsPerGbMonthPence: 2, scannedPerTbPence: 550 },
  uk: { objectPerGbMonthPence: 3, rowsPerGbMonthPence: 3, scannedPerTbPence: 600 },
};

/** §6 — the margin, and the only one in the pricing model that is stated as a margin. */
export const MARGIN_PERCENT = 10;

const GB = 1_024 ** 3;
const TB = 1_024 ** 4;

export type Measured = {
  bytesHeldObject: number;
  bytesHeldRows: number;
  bytesScanned: number;
};

export type Costed = {
  providerCostPence: number;
  /** What the customer is charged for it: cost plus the margin. */
  chargePence: number;
  breakdown: { object: number; rows: number; scanned: number };
  rates: Rates;
};

/**
 * What a measurement costs us, and what it is charged at.
 *
 * ── The cost is rounded once, at the end ───────────────────────────────────
 *
 * Rounding each line to the penny and adding them up produces a different total
 * from the one a customer computes from the bytes, and the difference is exactly
 * the kind that makes somebody distrust the rest of the invoice.
 *
 * ── The charge is then taken from the cost that was DISCLOSED ──────────────
 *
 * §6 publishes the provider cost and the 10% beside each other, so the one
 * arithmetic a customer will actually do is the disclosed cost times 1.1. Taking
 * the margin off the unrounded cost instead leaves the charge a penny away from
 * their answer — which is a stranger thing to have to explain than a rounding
 * rule, and it undermines the only disclosure in the pricing model.
 */
export function costOf(measured: Measured, rates: Rates): Costed {
  const breakdown = {
    object: (measured.bytesHeldObject / GB) * rates.objectPerGbMonthPence,
    rows: (measured.bytesHeldRows / GB) * rates.rowsPerGbMonthPence,
    scanned: (measured.bytesScanned / TB) * rates.scannedPerTbPence,
  };

  const providerCostPence = Math.round(breakdown.object + breakdown.rows + breakdown.scanned);

  return {
    providerCostPence,
    chargePence: Math.round((providerCostPence * (100 + MARGIN_PERCENT)) / 100),
    breakdown: {
      object: Math.round(breakdown.object),
      rows: Math.round(breakdown.rows),
      scanned: Math.round(breakdown.scanned),
    },
    rates,
  };
}

/**
 * §6 — "Usage above it bills at cost plus 10%. Nothing below it bills at all."
 *
 * THE ALLOWANCE COMES OFF THE BYTES, NOT OFF THE BILL. Taking it off the money
 * would make a gigabyte included under one rate card worth more than the same
 * gigabyte under another, which is not what "storage included" means.
 */
export function billable(held: number, includedBytes: number): number {
  return Math.max(0, held - includedBytes);
}
