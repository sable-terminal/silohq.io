// Data access for billing.token_balances, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  tokenBalanceTable,
  type NewTokenBalance,
  type TokenBalance,
  type TokenBalanceChanges,
} from '../../models/billing/tokenBalance.model.ts';

export const tokenBalanceRepo = {
  insert(db: Queryable, row: NewTokenBalance): Promise<TokenBalance> {
    return insertRow(db, tokenBalanceTable, row);
  },

  findById(db: Queryable, id: TokenBalance['id']): Promise<TokenBalance | undefined> {
    return findRow(db, tokenBalanceTable, { id });
  },

  findByMembershipId(
    db: Queryable,
    key: Pick<TokenBalance, 'organisationId' | 'membershipId'>,
  ): Promise<TokenBalance | undefined> {
    return findRow(db, tokenBalanceTable, key);
  },

  update(
    db: Queryable,
    id: TokenBalance['id'],
    changes: TokenBalanceChanges,
  ): Promise<TokenBalance | undefined> {
    return updateRow(db, tokenBalanceTable, { id }, changes);
  },

  // Opens the membership's balance with its onboarding grant, once ever (spec 73.4: 200
  // tokens on first activation). Undefined when the balance already existed.
  async open(db: Queryable, row: Required<Pick<NewTokenBalance, 'id' | 'organisationId' | 'membershipId' | 'onboardingGrantRemaining'>>)
    : Promise<TokenBalance | undefined> {
    const { rows } = await db.query(
      `insert into billing.token_balances (id, organisation_id, membership_id, onboarding_grant_remaining)
       values ($1, $2, $3, $4)
       on conflict (organisation_id, membership_id) do nothing
       returning ${tokenBalanceTable.select}`, [row.id, row.organisationId, row.membershipId, row.onboardingGrantRemaining]);
    return rows[0] as TokenBalance | undefined;
  },

  // The onboarding grant (spec 73.4: 200 tokens on first activation), once ever: given to a
  // balance whatever opened it (a purchase before the first seat, say). Undefined when it was
  // given before.
  async grantOnboarding(db: Queryable, row: { id: string; organisationId: string; membershipId: string; tokens: number }): Promise<TokenBalance | undefined> {
    const { rows } = await db.query(
      `insert into billing.token_balances (id, organisation_id, membership_id, onboarding_grant_remaining, onboarding_granted_at)
       values ($1, $2, $3, $4, now())
       on conflict (organisation_id, membership_id) do update
         set onboarding_grant_remaining = excluded.onboarding_grant_remaining, onboarding_granted_at = now()
         where billing.token_balances.onboarding_granted_at is null
       returning ${tokenBalanceTable.select}`, [row.id, row.organisationId, row.membershipId, row.tokens]);
    return rows[0] as TokenBalance | undefined;
  },

  async setAutoTopup(db: Queryable, id: string, enabled: boolean): Promise<void> {
    await db.query('update billing.token_balances set auto_topup = $2 where id = $1', [id, enabled]);
  },

  async lockByMembership(db: Queryable, membershipId: string): Promise<TokenBalance | undefined> {
    const { rows } = await db.query(
      `select ${tokenBalanceTable.select} from ${tokenBalanceTable.sql} where membership_id = $1 for update`, [membershipId]);
    return rows[0] as TokenBalance | undefined;
  },

  async findByMembership(db: Queryable, membershipId: string): Promise<TokenBalance | undefined> {
    const { rows } = await db.query(
      `select ${tokenBalanceTable.select} from ${tokenBalanceTable.sql} where membership_id = $1`, [membershipId]);
    return rows[0] as TokenBalance | undefined;
  },

  // Takes from the onboarding grant, the purchased tokens or the purchased simulations, only
  // when each holds enough. Undefined when one does not.
  async debit(db: Queryable, id: string, take: { grant: number; purchased: number; simulations: string })
    : Promise<TokenBalance | undefined> {
    const { rows } = await db.query(
      `update billing.token_balances
          set onboarding_grant_remaining = onboarding_grant_remaining - $2,
              purchased_remaining = purchased_remaining - $3,
              simulations_purchased_remaining = simulations_purchased_remaining - $4::numeric
        where id = $1 and onboarding_grant_remaining >= $2 and purchased_remaining >= $3
          and simulations_purchased_remaining >= $4::numeric
       returning ${tokenBalanceTable.select}`, [id, take.grant, take.purchased, take.simulations]);
    return rows[0] as TokenBalance | undefined;
  },

  // Adds purchased tokens or simulations, opening the balance (without a grant) if needed.
  async credit(db: Queryable, row: { id: string; organisationId: string; membershipId: string; tokens: number; simulations: number })
    : Promise<TokenBalance> {
    const { rows } = await db.query(
      `insert into billing.token_balances (id, organisation_id, membership_id, purchased_remaining, simulations_purchased_remaining)
       values ($1, $2, $3, $4, $5)
       on conflict (organisation_id, membership_id) do update
         set purchased_remaining = billing.token_balances.purchased_remaining + excluded.purchased_remaining,
             simulations_purchased_remaining = billing.token_balances.simulations_purchased_remaining
               + excluded.simulations_purchased_remaining
       returning ${tokenBalanceTable.select}`, [row.id, row.organisationId, row.membershipId, row.tokens, row.simulations]);
    return rows[0] as TokenBalance;
  },
};
