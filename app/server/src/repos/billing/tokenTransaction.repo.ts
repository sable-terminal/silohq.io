// Data access for billing.token_transactions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  tokenTransactionTable,
  type NewTokenTransaction,
  type TokenTransaction,
  type TokenTransactionPrimaryKey,
} from '../../models/billing/tokenTransaction.model.ts';

export const tokenTransactionRepo = {
  insert(db: Queryable, row: NewTokenTransaction): Promise<TokenTransaction> {
    return insertRow(db, tokenTransactionTable, row);
  },

  findByKey(db: Queryable, key: TokenTransactionPrimaryKey): Promise<TokenTransaction | undefined> {
    return findRow(db, tokenTransactionTable, key);
  },

  // A ledger row by its identity alone, for replaying a charge (the primary key leads with id).
  async findById(db: Queryable, id: string): Promise<TokenTransaction | undefined> {
    const { rows } = await db.query(
      `select ${tokenTransactionTable.select} from ${tokenTransactionTable.sql} where id = $1::bigint limit 1`, [id]);
    return rows[0] as TokenTransaction | undefined;
  },

  // The organisation's ledger, newest first, optionally one membership's, keyset-paged on
  // (occurred_at, id): the dispute view (spec 73.6).
  async list(db: Queryable, organisationId: string, options: {
    membershipId?: string | undefined; before?: { occurredAt: string; id: string } | undefined; limit: number;
  }): Promise<TokenTransaction[]> {
    const { rows } = await db.query(
      `select ${tokenTransactionTable.select} from ${tokenTransactionTable.sql}
       where organisation_id = $1 and ($2::uuid is null or membership_id = $2::uuid)
         and ($3::timestamptz is null or (occurred_at, id) < ($3::timestamptz, $4::bigint))
       order by occurred_at desc, id desc limit $5`,
      [organisationId, options.membershipId ?? null, options.before?.occurredAt ?? null, options.before?.id ?? null, options.limit]);
    return rows as TokenTransaction[];
  },

  // Units charged to an engagement by operation and source (spec 73.5: the engagement cost report).
  async engagementTotals(db: Queryable, organisationId: string, engagementId: string): Promise<EngagementTotal[]> {
    const { rows } = await db.query(
      `select operation, pool, source, sum(weight)::text as units, count(*)::int as charges
       from billing.token_transactions where organisation_id = $1 and engagement_id = $2
       group by operation, pool, source order by operation, source`, [organisationId, engagementId]);
    return rows as EngagementTotal[];
  },

  /** Tokens the organisation consumed from its allowances and its contract since `from` (74.3 overage). */
  async contractedTokensUsedSince(db: Queryable, from: string): Promise<number> {
    const { rows } = await db.query(
      `select coalesce(sum(weight), 0)::text as used from ${tokenTransactionTable.sql}
       where pool = 'tokens' and source in ('allowance', 'contract') and occurred_at >= $1`, [from]);
    return Math.round(Number((rows[0] as { used: string }).used));
  },
};

export interface EngagementTotal {
  operation: TokenTransaction['operation'];
  pool: TokenTransaction['pool'];
  source: TokenTransaction['source'];
  /** numeric as text. */
  units: string;
  charges: number;
}
