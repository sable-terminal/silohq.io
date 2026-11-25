// Data access for fde.fde_engagement_systems, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  fdeEngagementSystemTable,
  type FdeEngagementSystem,
  type FdeEngagementSystemChanges,
  type NewFdeEngagementSystem,
} from '../../models/fde/fdeEngagementSystem.model.ts';

export const fdeEngagementSystemRepo = {
  insert(db: Queryable, row: NewFdeEngagementSystem): Promise<FdeEngagementSystem> {
    return insertRow(db, fdeEngagementSystemTable, row);
  },

  findById(db: Queryable, id: FdeEngagementSystem['id']): Promise<FdeEngagementSystem | undefined> {
    return findRow(db, fdeEngagementSystemTable, { id });
  },

  findByEngagementIdAndSlug(
    db: Queryable,
    key: Pick<FdeEngagementSystem, 'organisationId' | 'engagementId' | 'slug'>,
  ): Promise<FdeEngagementSystem | undefined> {
    return findRow(db, fdeEngagementSystemTable, key);
  },

  /** An engagement's systems, in the order they were listed. */
  async listForEngagement(db: Queryable, engagementId: string): Promise<FdeEngagementSystem[]> {
    const { rows } = await db.query(
      `select ${fdeEngagementSystemTable.select} from fde.fde_engagement_systems where engagement_id = $1 order by listed_at, id`, [engagementId]);
    return rows as FdeEngagementSystem[];
  },

  update(
    db: Queryable,
    id: FdeEngagementSystem['id'],
    changes: FdeEngagementSystemChanges,
  ): Promise<FdeEngagementSystem | undefined> {
    return updateRow(db, fdeEngagementSystemTable, { id }, changes);
  },
};
