// Data access for billing.seats, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { seatTable, type NewSeat, type Seat, type SeatChanges } from '../../models/billing/seat.model.ts';

export const seatRepo = {
  insert(db: Queryable, row: NewSeat): Promise<Seat> {
    return insertRow(db, seatTable, row);
  },

  findById(db: Queryable, id: Seat['id']): Promise<Seat | undefined> {
    return findRow(db, seatTable, { id });
  },

  update(db: Queryable, id: Seat['id'], changes: SeatChanges): Promise<Seat | undefined> {
    return updateRow(db, seatTable, { id }, changes);
  },

  // The seat a membership occupies, if any (a membership holds at most one). Read by
  // metering: an allowance exists only for an assigned seat (spec 72.5).
  findAssigned(db: Queryable, membershipId: string): Promise<Seat | undefined> {
    return findRow(db, seatTable, { membershipId, status: 'assigned' });
  },

  // Suspension moves the membership's seat to reclaimed (spec 72.3), in the suspending
  // transaction. True when it held one.
  async reclaimFrom(db: Queryable, membershipId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `update billing.seats set status = 'reclaimed', membership_id = null, version = version + 1
        where membership_id = $1 and status = 'assigned'`, [membershipId]);
    return rowCount === 1;
  },

  async list(db: Queryable): Promise<Seat[]> {
    const { rows } = await db.query(`select ${seatTable.select} from billing.seats order by created_at, id`);
    return rows as Seat[];
  },

  /**
   * An available seat (unassigned or reclaimed), locked for the assigning transaction: from
   * the scope's pool, or with no scope the organisation's own seats. Oldest first.
   */
  async takeAvailable(db: Queryable, scopeId: string | null, planTier: Seat['planTier'] | undefined): Promise<Seat | undefined> {
    const { rows } = await db.query(
      `select ${seatTable.select} from billing.seats
       where status in ('unassigned', 'reclaimed') and allocated_scope_id is not distinct from $1 and ($2::text is null or plan_tier = $2)
       order by created_at, id limit 1 for update skip locked`, [scopeId, planTier ?? null]);
    return rows[0] as Seat | undefined;
  },

  /** Available seats in a scope's pool (or the organisation's, with no scope), for a tier. */
  async countAvailable(db: Queryable, scopeId: string | null, planTier: Seat['planTier']): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from billing.seats
       where status in ('unassigned', 'reclaimed') and allocated_scope_id is not distinct from $1 and plan_tier = $2`, [scopeId, planTier]);
    return (rows[0] as { n: number }).n;
  },

  /** Moves available seats between pools (a parent's to a child's, or back): how many moved. */
  async movePool(db: Queryable, from: string | null, to: string | null, planTier: Seat['planTier'], count: number, by: string, at: string): Promise<number> {
    if (count <= 0) return 0;
    const { rowCount } = await db.query(
      `update billing.seats set allocated_scope_id = $2, allocated_by = $5, allocated_at = $6, version = version + 1
       where id in (select id from billing.seats
                    where status in ('unassigned', 'reclaimed') and allocated_scope_id is not distinct from $1 and plan_tier = $3
                    order by created_at, id limit $4 for update skip locked)`, [from, to, planTier, count, by, at]);
    return rowCount ?? 0;
  },

  /** A subscription's seats still in the billable count. */
  async liveForSubscription(db: Queryable, subscriptionId: string): Promise<Seat[]> {
    const { rows } = await db.query(
      `select ${seatTable.select} from billing.seats where subscription_id = $1 and status <> 'released' order by created_at, id`, [subscriptionId]);
    return rows as Seat[];
  },

  /** Every seat of the organisation not released, whatever it came from (a sovereign customer's terms, D204). */
  async liveForOrganisation(db: Queryable): Promise<Seat[]> {
    const { rows } = await db.query(`select ${seatTable.select} from billing.seats where status <> 'released' order by created_at, id`);
    return rows as Seat[];
  },

  async liveForContract(db: Queryable, contractId: string): Promise<Seat[]> {
    const { rows } = await db.query(
      `select ${seatTable.select} from billing.seats where contract_id = $1 and status <> 'released' order by created_at, id`, [contractId]);
    return rows as Seat[];
  },
};
