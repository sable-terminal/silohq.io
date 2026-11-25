import type { Executor } from '../infra/db.infra';

/**
 * Simulation allowances: their own pool, never the token one.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. What a simulation costs and
 * who may buy one are the service's.
 */

export interface Allowance {
  periodStart: Date;
  periodEnd: Date;
  granted: number;
  consumed: number;
  purchasedRemaining: number;
}

type Row = {
  period_start: Date;
  period_end: Date;
  granted: number;
  consumed: number;
  purchased_remaining: number;
};

const map = (row: Row): Allowance => ({
  periodStart: row.period_start,
  periodEnd: row.period_end,
  granted: row.granted,
  consumed: row.consumed,
  purchasedRemaining: row.purchased_remaining,
});

/** The period's allowance, granted the first time it is asked for. */
export async function allowanceFor(
  db: Executor,
  input: {
    membershipId: string;
    organisationId: string;
    periodStart: Date;
    periodEnd: Date;
    granted: number;
  },
): Promise<{ allowance: Allowance; granted: boolean }> {
  const { rows } = await db.query<Row & { inserted: boolean }>(
    `INSERT INTO simulation_allowances
       (membership_id, organisation_id, period_start, period_end, granted)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (membership_id, period_start) DO UPDATE SET granted = simulation_allowances.granted
     RETURNING period_start, period_end, granted, consumed, purchased_remaining, (xmax = 0) AS inserted`,
    [input.membershipId, input.organisationId, input.periodStart, input.periodEnd, input.granted],
  );

  const row = rows[0]!;
  return { allowance: map(row), granted: row.inserted };
}

/** Spend one, from the allowance where there is any left, otherwise from what was bought. */
export async function consume(
  db: Executor,
  input: { membershipId: string; periodStart: Date; fromAllowance: boolean },
): Promise<void> {
  await db.query(
    input.fromAllowance
      ? `UPDATE simulation_allowances SET consumed = consumed + 1
          WHERE membership_id = $1 AND period_start = $2`
      : `UPDATE simulation_allowances SET purchased_remaining = purchased_remaining - 1
          WHERE membership_id = $1 AND period_start = $2 AND purchased_remaining > 0`,
    [input.membershipId, input.periodStart],
  );
}

/** What an organisation has been granted and has run this period. For the billing screen. */
export async function usageSince(
  db: Executor,
  input: { organisationId: string; from: Date },
): Promise<{ granted: number; consumed: number; purchasedRemaining: number }> {
  const { rows } = await db.query<{ granted: string; consumed: string; purchased: string }>(
    `SELECT COALESCE(SUM(granted), 0)::text AS granted,
            COALESCE(SUM(consumed), 0)::text AS consumed,
            COALESCE(SUM(purchased_remaining), 0)::text AS purchased
       FROM simulation_allowances
      WHERE organisation_id = $1 AND period_start >= $2`,
    [input.organisationId, input.from],
  );

  const row = rows[0];
  return {
    granted: Number(row?.granted ?? 0),
    consumed: Number(row?.consumed ?? 0),
    purchasedRemaining: Number(row?.purchased ?? 0),
  };
}
