// Data access for clone.spatial_anchors, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  spatialAnchorTable,
  type NewSpatialAnchor,
  type SpatialAnchor,
  type SpatialAnchorChanges,
} from '../../models/clone/spatialAnchor.model.ts';

export const spatialAnchorRepo = {
  insert(db: Queryable, row: NewSpatialAnchor): Promise<SpatialAnchor> {
    return insertRow(db, spatialAnchorTable, row);
  },

  findById(db: Queryable, id: SpatialAnchor['id']): Promise<SpatialAnchor | undefined> {
    return findRow(db, spatialAnchorTable, { id });
  },

  update(
    db: Queryable,
    id: SpatialAnchor['id'],
    changes: SpatialAnchorChanges,
  ): Promise<SpatialAnchor | undefined> {
    return updateRow(db, spatialAnchorTable, { id }, changes);
  },

  /** Anchors in place on the organisation's live plans and models. */
  async listLive(db: Queryable): Promise<SpatialAnchor[]> {
    const { rows } = await db.query(`select ${spatialAnchorTable.select} from clone.spatial_anchors where removed_at is null order by created_at, id limit 5000`);
    return rows as SpatialAnchor[];
  },

  /** The anchors in place on one plan for one object type, in the order they were set. */
  async liveOnPlan(db: Queryable, planId: string, objectTypeId: string): Promise<SpatialAnchor[]> {
    const { rows } = await db.query(
      `select ${spatialAnchorTable.select} from clone.spatial_anchors where plan_id = $1 and object_type_id = $2 and removed_at is null order by created_at, id limit 5000`,
      [planId, objectTypeId]);
    return rows as SpatialAnchor[];
  },

  /** The anchors in place on one model for one object type, in the order they were set. */
  async liveOnModel(db: Queryable, assetModelId: string, objectTypeId: string): Promise<SpatialAnchor[]> {
    const { rows } = await db.query(
      `select ${spatialAnchorTable.select} from clone.spatial_anchors where asset_model_id = $1 and object_type_id = $2 and removed_at is null order by created_at, id limit 5000`,
      [assetModelId, objectTypeId]);
    return rows as SpatialAnchor[];
  },

  /** Ends every anchor on a plan or a model (its purge): the ids ended. */
  async endFor(db: Queryable, target: { planId: string } | { assetModelId: string }, at: string): Promise<string[]> {
    const { rows } = 'planId' in target
      ? await db.query('update clone.spatial_anchors set removed_at = $2 where plan_id = $1 and removed_at is null returning id', [target.planId, at])
      : await db.query('update clone.spatial_anchors set removed_at = $2 where asset_model_id = $1 and removed_at is null returning id', [target.assetModelId, at]);
    return (rows as { id: string }[]).map((r) => r.id);
  },
};
