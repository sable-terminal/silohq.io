// Data access for clone.asset_models, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  assetModelTable,
  type AssetModel,
  type AssetModelChanges,
  type NewAssetModel,
} from '../../models/clone/assetModel.model.ts';

export const assetModelRepo = {
  insert(db: Queryable, row: NewAssetModel): Promise<AssetModel> {
    return insertRow(db, assetModelTable, row);
  },

  findById(db: Queryable, id: AssetModel['id']): Promise<AssetModel | undefined> {
    return findRow(db, assetModelTable, { id });
  },

  update(db: Queryable, id: AssetModel['id'], changes: AssetModelChanges): Promise<AssetModel | undefined> {
    return updateRow(db, assetModelTable, { id }, changes);
  },

  /** The organisation's models not purged, newest first (spec 29.5). */
  async listLive(db: Queryable): Promise<AssetModel[]> {
    const { rows } = await db.query(`select ${assetModelTable.select} from clone.asset_models where purged_at is null order by uploaded_at desc, id limit 500`);
    return rows as AssetModel[];
  },

  /** Models registered from these Silo files, not yet purged. */
  async liveForFiles(db: Queryable, siloFileIds: readonly string[]): Promise<AssetModel[]> {
    const { rows } = await db.query(
      `select ${assetModelTable.select} from clone.asset_models where silo_file_id = any($1::uuid[]) and purged_at is null order by id`, [siloFileIds]);
    return rows as AssetModel[];
  },
};
