// Data access for workspace.ml_models, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  mlModelTable,
  type MlModel,
  type MlModelChanges,
  type NewMlModel,
} from '../../models/workspace/mlModel.model.ts';

export const mlModelRepo = {
  insert(db: Queryable, row: NewMlModel): Promise<MlModel> {
    return insertRow(db, mlModelTable, row);
  },

  findById(db: Queryable, id: MlModel['id']): Promise<MlModel | undefined> {
    return findRow(db, mlModelTable, { id });
  },

  update(db: Queryable, id: MlModel['id'], changes: MlModelChanges): Promise<MlModel | undefined> {
    return updateRow(db, mlModelTable, { id }, changes);
  },

  async findForUpdate(db: Queryable, id: string): Promise<MlModel | undefined> {
    const { rows } = await db.query(`select ${mlModelTable.select} from workspace.ml_models where id = $1 for update`, [id]);
    return rows[0] as MlModel | undefined;
  },

  /** A member's own models, newest change first; archived ones only when asked for. */
  async listMine(db: Queryable, membershipId: string, archived: boolean, limit: number): Promise<MlModel[]> {
    const { rows } = await db.query(
      `select ${mlModelTable.select} from workspace.ml_models where owner_membership_id = $1 and (archived_at is not null) = $2
       order by updated_at desc limit $3`, [membershipId, archived, limit]);
    return rows as MlModel[];
  },

  async listByIds(db: Queryable, ids: readonly string[], limit: number): Promise<MlModel[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(
      `select ${mlModelTable.select} from workspace.ml_models where id = any($1::uuid[]) and archived_at is null order by updated_at desc limit $2`, [[...ids], limit]);
    return rows as MlModel[];
  },
};
