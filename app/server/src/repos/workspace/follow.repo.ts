// Data access for workspace.follows, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, type Queryable } from '../base.repo.ts';
import { followTable, type Follow, type NewFollow } from '../../models/workspace/follow.model.ts';

export const followRepo = {
  insert(db: Queryable, row: NewFollow): Promise<Follow> {
    return insertRow(db, followTable, row);
  },

  findById(db: Queryable, id: Follow['id']): Promise<Follow | undefined> {
    return findRow(db, followTable, { id });
  },

  findByMembershipIdAndResourceTypeAndResourceId(
    db: Queryable,
    key: Pick<Follow, 'organisationId' | 'membershipId' | 'resourceType' | 'resourceId'>,
  ): Promise<Follow | undefined> {
    return findRow(db, followTable, key);
  },

  remove(db: Queryable, id: Follow['id']): Promise<boolean> {
    return deleteRow(db, followTable, { id });
  },

  /** A member's follows, oldest first. */
  async listForMember(db: Queryable, membershipId: string): Promise<Follow[]> {
    const { rows } = await db.query(
      `select ${followTable.select} from workspace.follows where membership_id = $1 order by created_at, id`, [membershipId]);
    return rows as Follow[];
  },

  /** Follows of something that is gone (a deleted Cron, an archived view) end with it. */
  async removeForResource(db: Queryable, resourceType: Follow['resourceType'], resourceId: string): Promise<number> {
    const { rowCount } = await db.query('delete from workspace.follows where resource_type = $1 and resource_id = $2', [resourceType, resourceId]);
    return rowCount ?? 0;
  },
};
