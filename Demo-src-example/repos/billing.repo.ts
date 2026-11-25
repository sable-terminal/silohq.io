import type { Executor } from '../infra/db.infra';
import type { Plan } from '../models/organisation.model';
import type { Entitled, Term } from '../models/billing.model';

/**
 * Subscriptions and entitlements.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. What a plan costs and what it
 * entitles is `billing.model`; who may change it is the service's.
 */

export type SubscriptionStatus = 'active' | 'past_due' | 'suspended' | 'cancelled';

export interface Subscription {
  id: string;
  plan: Plan;
  seatCount: number;
  /** The lower count a mid-period release takes effect at, or null. */
  seatCountNext: number | null;
  term: Term;
  discountPercent: number;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  status: SubscriptionStatus;
  createdAt: Date;
}

export interface Entitlements extends Entitled {
  id: string;
  source: 'subscription' | 'contract';
  sourceId: string;
  effectiveFrom: Date;
}

type SubscriptionRow = {
  id: string;
  plan: Plan;
  seat_count: number;
  seat_count_next: number | null;
  term: Term;
  discount_percent: number;
  stripe_subscription_id: string | null;
  current_period_start: Date;
  current_period_end: Date;
  status: SubscriptionStatus;
  created_at: Date;
};

const SUBSCRIPTION_COLUMNS = `id, plan, seat_count, seat_count_next, term, discount_percent,
                              stripe_subscription_id, current_period_start, current_period_end,
                              status, created_at`;

const mapSubscription = (row: SubscriptionRow): Subscription => ({
  id: row.id,
  plan: row.plan,
  seatCount: row.seat_count,
  seatCountNext: row.seat_count_next,
  term: row.term,
  discountPercent: row.discount_percent,
  stripeSubscriptionId: row.stripe_subscription_id,
  currentPeriodStart: row.current_period_start,
  currentPeriodEnd: row.current_period_end,
  status: row.status,
  createdAt: row.created_at,
});

export async function subscription(db: Executor, organisationId: string): Promise<Subscription | null> {
  const { rows } = await db.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
      WHERE organisation_id = $1 AND cancelled_at IS NULL`,
    [organisationId],
  );
  return rows[0] ? mapSubscription(rows[0]) : null;
}

/** The subscription, locked, for a change that reads it and then writes it. */
export async function lockSubscription(db: Executor, organisationId: string): Promise<Subscription | null> {
  const { rows } = await db.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
      WHERE organisation_id = $1 AND cancelled_at IS NULL FOR UPDATE`,
    [organisationId],
  );
  return rows[0] ? mapSubscription(rows[0]) : null;
}

export async function createSubscription(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    plan: Plan;
    seatCount: number;
    term: Term;
    discountPercent: number;
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<Subscription> {
  const { rows } = await db.query<SubscriptionRow>(
    `INSERT INTO subscriptions
       (id, organisation_id, plan, seat_count, term, discount_percent, current_period_start, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${SUBSCRIPTION_COLUMNS}`,
    [
      input.id,
      input.organisationId,
      input.plan,
      input.seatCount,
      input.term,
      input.discountPercent,
      input.periodStart,
      input.periodEnd,
    ],
  );
  return mapSubscription(rows[0]!);
}

export async function updateSubscription(
  db: Executor,
  input: {
    id: string;
    plan?: Plan;
    seatCount?: number;
    /** Pass null to clear a scheduled reduction. */
    seatCountNext?: number | null;
    term?: Term;
    discountPercent?: number;
    status?: SubscriptionStatus;
    periodStart?: Date;
    periodEnd?: Date;
  },
): Promise<Subscription> {
  const { rows } = await db.query<SubscriptionRow>(
    `UPDATE subscriptions
        SET plan                 = COALESCE($2, plan),
            seat_count           = COALESCE($3, seat_count),
            seat_count_next      = CASE WHEN $4::boolean THEN $5 ELSE seat_count_next END,
            term                 = COALESCE($6, term),
            discount_percent     = COALESCE($7, discount_percent),
            status               = COALESCE($8, status),
            current_period_start = COALESCE($9, current_period_start),
            current_period_end   = COALESCE($10, current_period_end),
            cancelled_at         = CASE WHEN $8 = 'cancelled' THEN now() ELSE cancelled_at END
      WHERE id = $1
      RETURNING ${SUBSCRIPTION_COLUMNS}`,
    [
      input.id,
      input.plan ?? null,
      input.seatCount ?? null,
      'seatCountNext' in input,
      input.seatCountNext ?? null,
      input.term ?? null,
      input.discountPercent ?? null,
      input.status ?? null,
      input.periodStart ?? null,
      input.periodEnd ?? null,
    ],
  );
  return mapSubscription(rows[0]!);
}

/** Subscriptions whose period has run out, for the roll. Cross-tenant: the sweep's. */
export async function dueToRoll(
  db: Executor,
): Promise<Array<{ id: string; organisationId: string }>> {
  const { rows } = await db.query<{ id: string; organisation_id: string }>(
    `SELECT id, organisation_id FROM subscriptions
      WHERE cancelled_at IS NULL AND current_period_end <= now()
      ORDER BY current_period_end`,
  );
  return rows.map((row) => ({ id: row.id, organisationId: row.organisation_id }));
}

/* ── Entitlements ─────────────────────────────────────────────────────────── */

type EntitlementRow = {
  id: string;
  seats: number;
  tokens_per_seat: number;
  simulations_per_seat: number;
  daily_token_limit: number | null;
  storage_included_bytes: string;
  minimum_interval_minutes: number;
  capabilities: string[];
  source: 'subscription' | 'contract';
  source_id: string;
  effective_from: Date;
};

const ENTITLEMENT_COLUMNS = `id, seats, tokens_per_seat, simulations_per_seat, daily_token_limit,
                             storage_included_bytes, minimum_interval_minutes,
                             capabilities, source, source_id, effective_from`;

const mapEntitlements = (row: EntitlementRow): Entitlements => ({
  id: row.id,
  seats: row.seats,
  tokensPerSeat: row.tokens_per_seat,
  simulationsPerSeat: row.simulations_per_seat,
  dailyTokenLimit: row.daily_token_limit,
  /* `bigint` arrives as a string; bytes are counted, so it becomes a number here. */
  storageIncludedBytes: Number(row.storage_included_bytes),
  minimumIntervalMinutes: row.minimum_interval_minutes,
  capabilities: row.capabilities,
  source: row.source,
  sourceId: row.source_id,
  effectiveFrom: row.effective_from,
});

/** What this organisation is entitled to now. */
export async function entitlements(db: Executor, organisationId: string): Promise<Entitlements | null> {
  const { rows } = await db.query<EntitlementRow>(
    `SELECT ${ENTITLEMENT_COLUMNS} FROM entitlements
      WHERE organisation_id = $1 AND effective_to IS NULL`,
    [organisationId],
  );
  return rows[0] ? mapEntitlements(rows[0]) : null;
}

/**
 * Put a new version in force, closing the one before it.
 *
 * ONE STATEMENT EACH, IN ONE TRANSACTION, and the unique index refuses two
 * current versions however they arrive.
 */
export async function setEntitlements(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    entitled: Entitled;
    source: 'subscription' | 'contract';
    sourceId: string;
    at?: Date;
  },
): Promise<Entitlements> {
  const at = input.at ?? new Date();

  await db.query(
    `UPDATE entitlements SET effective_to = $2
      WHERE organisation_id = $1 AND effective_to IS NULL AND effective_from < $2`,
    [input.organisationId, at],
  );

  const { rows } = await db.query<EntitlementRow>(
    `INSERT INTO entitlements
       (id, organisation_id, seats, tokens_per_seat, simulations_per_seat, daily_token_limit,
        storage_included_bytes, minimum_interval_minutes, capabilities, source, source_id, effective_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12)
     RETURNING ${ENTITLEMENT_COLUMNS}`,
    [
      input.id,
      input.organisationId,
      input.entitled.seats,
      input.entitled.tokensPerSeat,
      input.entitled.simulationsPerSeat,
      input.entitled.dailyTokenLimit,
      input.entitled.storageIncludedBytes,
      input.entitled.minimumIntervalMinutes,
      input.entitled.capabilities,
      input.source,
      input.sourceId,
      at,
    ],
  );

  return mapEntitlements(rows[0]!);
}
