// Data access for billing.seat_allocations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  seatAllocationTable,
  type NewSeatAllocation,
  type SeatAllocation,
  type SeatAllocationChanges,
} from '../../models/billing/seatAllocation.model.ts';

export const seatAllocationRepo = {
  insert(db: Queryable, row: NewSeatAllocation): Promise<SeatAllocation> {
    return insertRow(db, seatAllocationTable, row);
  },

  findById(db: Queryable, id: SeatAllocation['id']): Promise<SeatAllocation | undefined> {
    return findRow(db, seatAllocationTable, { id });
  },

  findByScopeIdAndPlanTier(
    db: Queryable,
    key: Pick<SeatAllocation, 'organisationId' | 'scopeId' | 'planTier'>,
  ): Promise<SeatAllocation | undefined> {
    return findRow(db, seatAllocationTable, key);
  },

  update(
    db: Queryable,
    id: SeatAllocation['id'],
    changes: SeatAllocationChanges,
  ): Promise<SeatAllocation | undefined> {
    return updateRow(db, seatAllocationTable, { id }, changes);
  },

  async list(db: Queryable): Promise<SeatAllocation[]> {
    const { rows } = await db.query(`select ${seatAllocationTable.select} from billing.seat_allocations order by allocated_at, id`);
    return rows as SeatAllocation[];
  },
};
