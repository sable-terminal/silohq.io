// Data access for workspace.workspace_preferences, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  workspacePreferenceTable,
  type NewWorkspacePreference,
  type WorkspacePreference,
  type WorkspacePreferenceChanges,
  type WorkspacePreferencePrimaryKey,
} from '../../models/workspace/workspacePreference.model.ts';

export const workspacePreferenceRepo = {
  insert(db: Queryable, row: NewWorkspacePreference): Promise<WorkspacePreference> {
    return insertRow(db, workspacePreferenceTable, row);
  },

  findByKey(db: Queryable, key: WorkspacePreferencePrimaryKey): Promise<WorkspacePreference | undefined> {
    return findRow(db, workspacePreferenceTable, key);
  },

  update(
    db: Queryable,
    key: WorkspacePreferencePrimaryKey,
    changes: WorkspacePreferenceChanges,
  ): Promise<WorkspacePreference | undefined> {
    return updateRow(db, workspacePreferenceTable, key, changes);
  },
};
