// Data access for billing.subscriptions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  subscriptionTable,
  type NewSubscription,
  type Subscription,
  type SubscriptionChanges,
} from '../../models/billing/subscription.model.ts';

export const subscriptionRepo = {
  /** Live subscriptions counted above their billable seats, in every organisation (security definer; 72.2). */
  async seatDrift(db: Queryable, limit: number): Promise<string[]> {
    const { rows } = await db.query('select organisation_id from billing.subscriptions_seat_drift($1)', [limit]);
    return (rows as { organisation_id: string }[]).map((r) => r.organisation_id);
  },

  insert(db: Queryable, row: NewSubscription): Promise<Subscription> {
    return insertRow(db, subscriptionTable, row);
  },

  findById(db: Queryable, id: Subscription['id']): Promise<Subscription | undefined> {
    return findRow(db, subscriptionTable, { id });
  },

  findByStripeSubscriptionId(
    db: Queryable,
    stripeSubscriptionId: Subscription['stripeSubscriptionId'],
  ): Promise<Subscription | undefined> {
    return findRow(db, subscriptionTable, { stripeSubscriptionId });
  },

  update(
    db: Queryable,
    id: Subscription['id'],
    changes: SubscriptionChanges,
  ): Promise<Subscription | undefined> {
    return updateRow(db, subscriptionTable, { id }, changes);
  },

  // The organisation's live subscription: at most one is not cancelled.
  async findLive(db: Queryable, organisationId: string): Promise<Subscription | undefined> {
    const { rows } = await db.query(
      `select ${subscriptionTable.select} from ${subscriptionTable.sql} where organisation_id = $1 and status <> 'cancelled'`,
      [organisationId]);
    return rows[0] as Subscription | undefined;
  },

  // The newest subscription, live or not: its customer raises further provider objects.
  async findLatest(db: Queryable, organisationId: string): Promise<Subscription | undefined> {
    const { rows } = await db.query(
      `select ${subscriptionTable.select} from ${subscriptionTable.sql} where organisation_id = $1
       order by created_at desc limit 1`, [organisationId]);
    return rows[0] as Subscription | undefined;
  },

  // The mirror of one provider subscription, locked while a webhook applies it.
  async lockByStripeSubscriptionId(db: Queryable, stripeSubscriptionId: string): Promise<Subscription | undefined> {
    const { rows } = await db.query(
      `select ${subscriptionTable.select} from ${subscriptionTable.sql} where stripe_subscription_id = $1 for update`,
      [stripeSubscriptionId]);
    return rows[0] as Subscription | undefined;
  },
};
