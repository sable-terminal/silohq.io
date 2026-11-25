// Data access for workspace.ml_model_versions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  mlModelVersionTable,
  type MlModelVersion,
  type NewMlModelVersion,
} from '../../models/workspace/mlModelVersion.model.ts';

export const mlModelVersionRepo = {
  insert(db: Queryable, row: NewMlModelVersion): Promise<MlModelVersion> {
    return insertRow(db, mlModelVersionTable, row);
  },

  findById(db: Queryable, id: MlModelVersion['id']): Promise<MlModelVersion | undefined> {
    return findRow(db, mlModelVersionTable, { id });
  },

  findByModelIdAndVersion(
    db: Queryable,
    key: Pick<MlModelVersion, 'organisationId' | 'modelId' | 'version'>,
  ): Promise<MlModelVersion | undefined> {
    return findRow(db, mlModelVersionTable, key);
  },

  /** A model's versions, newest first. */
  async listForModel(db: Queryable, modelId: string): Promise<MlModelVersion[]> {
    const { rows } = await db.query(`select ${mlModelVersionTable.select} from workspace.ml_model_versions where model_id = $1 order by version desc`, [modelId]);
    return rows as MlModelVersion[];
  },

  /** The next version number; the model's row is locked by the caller, so two trainings never share one. */
  async nextVersion(db: Queryable, modelId: string): Promise<number> {
    const { rows } = await db.query(`select coalesce(max(version), 0) + 1 as next from workspace.ml_model_versions where model_id = $1`, [modelId]);
    return Number(rows[0].next);
  },
};
