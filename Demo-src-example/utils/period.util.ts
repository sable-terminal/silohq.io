/**
 * Billing period boundaries, proration and the daily reset.
 *
 * MONTH ARITHMETIC IS WHERE BILLING BUGS LIVE. A subscription starting on the
 * 31st has no 31st in February, and the naive answer — roll into March — moves
 * the anniversary permanently, so a customer billed on the 31st is billed on the
 * 3rd forever after. The rule here is to clamp to the last day of the month and
 * keep the original anchor, so 31 January bills on 28 February and then 31 March.
 *
 * EVERYTHING IS UTC. A period boundary computed in local time moves twice a year,
 * and a daily limit that resets at midnight local silently gives an extra hour of
 * allowance in October and takes one in March.
 */

export interface Period {
  start: Date;
  end: Date;
}

/** Days in a month, UTC. Month is 0-indexed as in `Date`. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Add months, clamping the day rather than rolling over.
 *
 * The anchor day is passed separately so it survives a clamp: 31 Jan → 28 Feb →
 * 31 Mar, not 31 Jan → 28 Feb → 28 Mar.
 */
export function addMonths(from: Date, months: number, anchorDay?: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = anchorDay ?? from.getUTCDate();

  const targetMonth = month + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalisedMonth = ((targetMonth % 12) + 12) % 12;

  return new Date(
    Date.UTC(
      targetYear,
      normalisedMonth,
      Math.min(day, daysInMonth(targetYear, normalisedMonth)),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
    ),
  );
}

export function currentPeriod(
  subscriptionStart: Date,
  term: 'monthly' | 'annual',
  now = new Date(),
): Period {
  const anchorDay = subscriptionStart.getUTCDate();
  const step = term === 'annual' ? 12 : 1;

  let start = subscriptionStart;
  let end = addMonths(start, step, anchorDay);

  // Walked forward rather than computed, because clamping makes period lengths
  // uneven and a division would drift.
  while (end <= now) {
    start = end;
    end = addMonths(start, step, anchorDay);
  }

  return { start, end };
}

/**
 * The fraction of a period remaining, for prorating an allowance.
 *
 * ALLOWANCE IS CREATED ON ASSIGNMENT, NOT PURCHASE. An unassigned seat accrues
 * nothing — otherwise fifty seats with five assigned produce forty-five
 * allowances that are either wasted or quietly become a pool, which undermines
 * the rule that allowances do not pool.
 */
export function prorationFactor(period: Period, assignedAt: Date): number {
  const total = period.end.getTime() - period.start.getTime();
  if (total <= 0) return 0;
  const remaining = period.end.getTime() - Math.max(assignedAt.getTime(), period.start.getTime());
  return Math.max(0, Math.min(1, remaining / total));
}

export function prorate(fullAllowance: number, period: Period, assignedAt: Date): number {
  return Math.floor(fullAllowance * prorationFactor(period, assignedAt));
}

/** The UTC day a daily limit is counted against. */
export function dailyWindow(now = new Date()): Period {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0),
  );
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

export function isWithin(period: Period, at: Date): boolean {
  // Start inclusive, end exclusive, so consecutive periods neither overlap nor
  // leave a gap at the boundary.
  return at >= period.start && at < period.end;
}
