// Data access for workspace.app_release_stages, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  appReleaseStageTable,
  type AppReleaseStage,
  type AppReleaseStageChanges,
  type NewAppReleaseStage,
} from '../../models/workspace/appReleaseStage.model.ts';

export const appReleaseStageRepo = {
  insert(db: Queryable, row: NewAppReleaseStage): Promise<AppReleaseStage> {
    return insertRow(db, appReleaseStageTable, row);
  },

  findById(db: Queryable, id: AppReleaseStage['id']): Promise<AppReleaseStage | undefined> {
    return findRow(db, appReleaseStageTable, { id });
  },

  findByReleaseIdAndOrdinal(
    db: Queryable,
    key: Pick<AppReleaseStage, 'organisationId' | 'releaseId' | 'ordinal'>,
  ): Promise<AppReleaseStage | undefined> {
    return findRow(db, appReleaseStageTable, key);
  },

  update(
    db: Queryable,
    id: AppReleaseStage['id'],
    changes: AppReleaseStageChanges,
  ): Promise<AppReleaseStage | undefined> {
    return updateRow(db, appReleaseStageTable, { id }, changes);
  },

  async listForRelease(db: Queryable, releaseId: string): Promise<AppReleaseStage[]> {
    const { rows } = await db.query(
      `select ${appReleaseStageTable.select} from workspace.app_release_stages where release_id = $1 order by ordinal`, [releaseId]);
    return rows as AppReleaseStage[];
  },
};
