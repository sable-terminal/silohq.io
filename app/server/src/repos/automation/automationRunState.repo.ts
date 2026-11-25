// Data access for automation.automation_run_state, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app; written by silo_app.
// silo_report may read only some columns, so cannot use these finders, which
// select every column; give them their own query.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  automationRunStateTable,
  type AutomationRunState,
  type AutomationRunStateChanges,
  type AutomationRunStatePrimaryKey,
  type NewAutomationRunState,
} from '../../models/automation/automationRunState.model.ts';

export const automationRunStateRepo = {
  insert(db: Queryable, row: NewAutomationRunState): Promise<AutomationRunState> {
    return insertRow(db, automationRunStateTable, row);
  },

  findByKey(db: Queryable, key: AutomationRunStatePrimaryKey): Promise<AutomationRunState | undefined> {
    return findRow(db, automationRunStateTable, key);
  },

  update(
    db: Queryable,
    key: AutomationRunStatePrimaryKey,
    changes: AutomationRunStateChanges,
  ): Promise<AutomationRunState | undefined> {
    return updateRow(db, automationRunStateTable, key, changes);
  },
};
