// Data access for clone.live_subscriptions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  liveSubscriptionTable,
  type LiveSubscription,
  type LiveSubscriptionChanges,
  type NewLiveSubscription,
} from '../../models/clone/liveSubscription.model.ts';

export const liveSubscriptionRepo = {
  insert(db: Queryable, row: NewLiveSubscription): Promise<LiveSubscription> {
    return insertRow(db, liveSubscriptionTable, row);
  },

  findById(db: Queryable, id: LiveSubscription['id']): Promise<LiveSubscription | undefined> {
    return findRow(db, liveSubscriptionTable, { id });
  },

  update(
    db: Queryable,
    id: LiveSubscription['id'],
    changes: LiveSubscriptionChanges,
  ): Promise<LiveSubscription | undefined> {
    return updateRow(db, liveSubscriptionTable, { id }, changes);
  },

  /**
   * A membership's open subscriptions and the objects they hold (spec 30.5 bounds). One
   * whose holder stopped renewing before freshSince is lapsed, though not yet swept.
   */
  async activeForMembership(db: Queryable, membershipId: string, freshSince: string): Promise<{ subscriptions: number; objects: number }> {
    const { rows } = await db.query(
      `select count(*)::int as subscriptions, coalesce(sum(object_count), 0)::int as objects from clone.live_subscriptions
        where membership_id = $1 and ended_at is null and last_heartbeat_at >= $2`, [membershipId, freshSince]);
    return rows[0] as { subscriptions: number; objects: number };
  },

  /** Whether this call ended it (false when it had ended already). */
  async end(db: Queryable, id: LiveSubscription['id'], reason: NonNullable<LiveSubscription['endReason']>): Promise<boolean> {
    const { rowCount } = await db.query('update clone.live_subscriptions set ended_at = now(), end_reason = $2 where id = $1 and ended_at is null', [id, reason]);
    return (rowCount ?? 0) > 0;
  },

  async heartbeat(db: Queryable, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await db.query('update clone.live_subscriptions set last_heartbeat_at = now() where id = any($1::uuid[]) and ended_at is null', [ids]);
  },
};
