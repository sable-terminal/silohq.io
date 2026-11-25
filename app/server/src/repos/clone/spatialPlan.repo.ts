// Data access for clone.spatial_plans, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  spatialPlanTable,
  type NewSpatialPlan,
  type SpatialPlan,
  type SpatialPlanChanges,
} from '../../models/clone/spatialPlan.model.ts';

export const spatialPlanRepo = {
  insert(db: Queryable, row: NewSpatialPlan): Promise<SpatialPlan> {
    return insertRow(db, spatialPlanTable, row);
  },

  findById(db: Queryable, id: SpatialPlan['id']): Promise<SpatialPlan | undefined> {
    return findRow(db, spatialPlanTable, { id });
  },

  update(
    db: Queryable,
    id: SpatialPlan['id'],
    changes: SpatialPlanChanges,
  ): Promise<SpatialPlan | undefined> {
    return updateRow(db, spatialPlanTable, { id }, changes);
  },

  /** The organisation's plans not purged, newest first (spec 29.4). */
  async listLive(db: Queryable): Promise<SpatialPlan[]> {
    const { rows } = await db.query(`select ${spatialPlanTable.select} from clone.spatial_plans where purged_at is null order by uploaded_at desc, id limit 500`);
    return rows as SpatialPlan[];
  },

  /** Plans registered from these Silo files, not yet purged: the ones a file's purge reaches. */
  async liveForFiles(db: Queryable, siloFileIds: readonly string[]): Promise<SpatialPlan[]> {
    const { rows } = await db.query(
      `select ${spatialPlanTable.select} from clone.spatial_plans where silo_file_id = any($1::uuid[]) and purged_at is null order by id`, [siloFileIds]);
    return rows as SpatialPlan[];
  },
};
