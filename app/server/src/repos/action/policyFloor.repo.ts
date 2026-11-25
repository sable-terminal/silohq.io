// Data access for action.policy_floors, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  policyFloorTable,
  type NewPolicyFloor,
  type PolicyFloor,
  type PolicyFloorChanges,
} from '../../models/action/policyFloor.model.ts';

export const policyFloorRepo = {
  insert(db: Queryable, row: NewPolicyFloor): Promise<PolicyFloor> {
    return insertRow(db, policyFloorTable, row);
  },

  findById(db: Queryable, id: PolicyFloor['id']): Promise<PolicyFloor | undefined> {
    return findRow(db, policyFloorTable, { id });
  },

  update(
    db: Queryable,
    id: PolicyFloor['id'],
    changes: PolicyFloorChanges,
  ): Promise<PolicyFloor | undefined> {
    return updateRow(db, policyFloorTable, { id }, changes);
  },

  async listLive(db: Queryable): Promise<PolicyFloor[]> {
    const { rows } = await db.query(`select ${policyFloorTable.select} from action.policy_floors where superseded_at is null order by set_at`);
    return rows as PolicyFloor[];
  },
};
