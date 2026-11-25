import type { Executor } from '../infra/db.infra';

/**
 * Token allowances, balances, charges and purchases.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. What an operation weighs and
 * which balance it comes out of is `tokenMeter.util`; who may buy is the
 * service's.
 */

export interface Allowance {
  periodStart: Date;
  periodEnd: Date;
  granted: number;
  consumed: number;
  dailyLimit: number | null;
}

export interface Balances {
  purchasedRemaining: number;
  grantRemaining: number;
  autoTopUp: boolean;
}

type AllowanceRow = {
  period_start: Date;
  period_end: Date;
  granted: number;
  consumed: number;
  daily_limit: number | null;
};

const mapAllowance = (row: AllowanceRow): Allowance => ({
  periodStart: row.period_start,
  periodEnd: row.period_end,
  granted: row.granted,
  consumed: row.consumed,
  dailyLimit: row.daily_limit,
});

/**
 * The allowance for one period, granted if this is the first time it is asked
 * for.
 *
 * GRANTED ON FIRST USE RATHER THAN BY A JOB. A monthly grant driven by a
 * scheduler means an organisation whose job did not run has no allowance and
 * cannot work; asking for it creates it, and the primary key makes two racing
 * requests one grant.
 */
export async function allowanceFor(
  db: Executor,
  input: {
    membershipId: string;
    organisationId: string;
    periodStart: Date;
    periodEnd: Date;
    granted: number;
    dailyLimit: number | null;
  },
): Promise<{ allowance: Allowance; granted: boolean }> {
  const { rows } = await db.query<AllowanceRow & { inserted: boolean }>(
    `INSERT INTO token_allowances
       (membership_id, organisation_id, period_start, period_end, granted, daily_limit)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (membership_id, period_start) DO UPDATE
       SET daily_limit = EXCLUDED.daily_limit
     RETURNING period_start, period_end, granted, consumed, daily_limit,
               (xmax = 0) AS inserted`,
    [
      input.membershipId,
      input.organisationId,
      input.periodStart,
      input.periodEnd,
      input.granted,
      input.dailyLimit,
    ],
  );

  const row = rows[0]!;
  return { allowance: mapAllowance(row), granted: row.inserted };
}

/** The allowance, locked, for a charge that reads it and then writes it. */
export async function lockAllowance(
  db: Executor,
  input: { membershipId: string; periodStart: Date },
): Promise<Allowance | null> {
  const { rows } = await db.query<AllowanceRow>(
    `SELECT period_start, period_end, granted, consumed, daily_limit
       FROM token_allowances WHERE membership_id = $1 AND period_start = $2 FOR UPDATE`,
    [input.membershipId, input.periodStart],
  );
  return rows[0] ? mapAllowance(rows[0]) : null;
}

export async function consumeAllowance(
  db: Executor,
  input: { membershipId: string; periodStart: Date; tokens: number },
): Promise<void> {
  await db.query(
    `UPDATE token_allowances SET consumed = consumed + $3
      WHERE membership_id = $1 AND period_start = $2`,
    [input.membershipId, input.periodStart, input.tokens],
  );
}

/** What this membership has consumed from its allowance today. */
export async function consumedToday(db: Executor, membershipId: string): Promise<number> {
  const { rows } = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(weight), 0)::text AS total
       FROM token_transactions
      WHERE membership_id = $1 AND source = 'allowance' AND occurred_at >= date_trunc('day', now())`,
    [membershipId],
  );
  return Number(rows[0]?.total ?? 0);
}

type BalanceRow = { purchased_remaining: number; grant_remaining: number; auto_top_up: boolean };

const mapBalances = (row: BalanceRow): Balances => ({
  purchasedRemaining: row.purchased_remaining,
  grantRemaining: row.grant_remaining,
  autoTopUp: row.auto_top_up,
});

/**
 * The balances, creating them with the onboarding grant if this membership has
 * never had any.
 *
 * §4 — THE GRANT IS GIVEN ONCE, ON FIRST ACTIVATION, and is outside the
 * allowance. The row existing is what says it has been given.
 */
export async function balancesFor(
  db: Executor,
  input: { membershipId: string; organisationId: string; grant: number },
): Promise<{ balances: Balances; granted: boolean }> {
  const { rows } = await db.query<BalanceRow & { inserted: boolean }>(
    `INSERT INTO token_balances (membership_id, organisation_id, grant_remaining)
     VALUES ($1, $2, $3)
     ON CONFLICT (membership_id) DO UPDATE SET updated_at = token_balances.updated_at
     RETURNING purchased_remaining, grant_remaining, auto_top_up, (xmax = 0) AS inserted`,
    [input.membershipId, input.organisationId, input.grant],
  );

  const row = rows[0]!;
  return { balances: mapBalances(row), granted: row.inserted };
}

export async function lockBalances(db: Executor, membershipId: string): Promise<Balances | null> {
  const { rows } = await db.query<BalanceRow>(
    `SELECT purchased_remaining, grant_remaining, auto_top_up FROM token_balances
      WHERE membership_id = $1 FOR UPDATE`,
    [membershipId],
  );
  return rows[0] ? mapBalances(rows[0]) : null;
}

export async function spendBalances(
  db: Executor,
  input: { membershipId: string; fromGrant: number; fromPurchased: number },
): Promise<void> {
  await db.query(
    `UPDATE token_balances
        SET grant_remaining = grant_remaining - $2,
            purchased_remaining = purchased_remaining - $3,
            updated_at = now()
      WHERE membership_id = $1`,
    [input.membershipId, input.fromGrant, input.fromPurchased],
  );
}

export async function addPurchased(
  db: Executor,
  input: { membershipId: string; tokens: number },
): Promise<void> {
  await db.query(
    `UPDATE token_balances SET purchased_remaining = purchased_remaining + $2, updated_at = now()
      WHERE membership_id = $1`,
    [input.membershipId, input.tokens],
  );
}

export async function setAutoTopUp(
  db: Executor,
  input: { membershipId: string; enabled: boolean },
): Promise<void> {
  await db.query(
    `UPDATE token_balances SET auto_top_up = $2, updated_at = now() WHERE membership_id = $1`,
    [input.membershipId, input.enabled],
  );
}

/** One charge, as one row per balance it drew from. */
export async function record(
  db: Executor,
  input: {
    organisationId: string;
    membershipId: string;
    operation: string;
    correlationId: string;
    parts: ReadonlyArray<{ source: 'grant' | 'allowance' | 'purchased'; weight: number }>;
  },
): Promise<void> {
  const parts = input.parts.filter((part) => part.weight > 0);
  if (parts.length === 0) return;

  await db.query(
    `INSERT INTO token_transactions
       (id, organisation_id, membership_id, operation, weight, source, correlation_id)
     SELECT gen_random_uuid(), $1, $2, $3, r.weight, r.source, $4
       FROM jsonb_to_recordset($5::jsonb) AS r(source text, weight integer)`,
    [
      input.organisationId,
      input.membershipId,
      input.operation,
      input.correlationId,
      JSON.stringify(parts),
    ],
  );
}

export async function recordPurchase(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    membershipId: string;
    kind: 'tokens' | 'simulations';
    quantity: number;
    amountPence: number;
    auto: boolean;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO purchases (id, organisation_id, membership_id, kind, quantity, amount_pence, auto)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.organisationId,
      input.membershipId,
      input.kind,
      input.quantity,
      input.amountPence,
      input.auto,
    ],
  );
}

/** What an organisation has spent this period, per operation. For the usage screen and the invoice. */
export async function spendByOperation(
  db: Executor,
  input: { organisationId: string; from: Date },
): Promise<Array<{ operation: string; tokens: number }>> {
  const { rows } = await db.query<{ operation: string; tokens: string }>(
    `SELECT operation, SUM(weight)::text AS tokens
       FROM token_transactions
      WHERE organisation_id = $1 AND occurred_at >= $2
      GROUP BY operation
      ORDER BY operation`,
    [input.organisationId, input.from],
  );
  return rows.map((row) => ({ operation: row.operation, tokens: Number(row.tokens) }));
}

/** What was bought this period, for the usage screen and the invoice that follows it. */
export async function purchasesSince(
  db: Executor,
  input: { organisationId: string; from: Date },
): Promise<Array<{ kind: 'tokens' | 'simulations'; quantity: number; amountPence: number; auto: boolean; occurredAt: Date }>> {
  const { rows } = await db.query<{
    kind: 'tokens' | 'simulations';
    quantity: number;
    amount_pence: number;
    auto: boolean;
    occurred_at: Date;
  }>(
    `SELECT kind, quantity, amount_pence, auto, occurred_at
       FROM purchases WHERE organisation_id = $1 AND occurred_at >= $2
      ORDER BY occurred_at DESC`,
    [input.organisationId, input.from],
  );
  return rows.map((row) => ({
    kind: row.kind,
    quantity: row.quantity,
    amountPence: row.amount_pence,
    auto: row.auto,
    occurredAt: row.occurred_at,
  }));
}
