// Data access for automation.automation_run_actions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  automationRunActionTable,
  type AutomationRunAction,
  type AutomationRunActionChanges,
  type NewAutomationRunAction,
} from '../../models/automation/automationRunAction.model.ts';

export const automationRunActionRepo = {
  insert(db: Queryable, row: NewAutomationRunAction): Promise<AutomationRunAction> {
    return insertRow(db, automationRunActionTable, row);
  },

  findById(db: Queryable, id: AutomationRunAction['id']): Promise<AutomationRunAction | undefined> {
    return findRow(db, automationRunActionTable, { id });
  },

  findByRunIdAndSequence(
    db: Queryable,
    key: Pick<AutomationRunAction, 'organisationId' | 'runId' | 'sequence'>,
  ): Promise<AutomationRunAction | undefined> {
    return findRow(db, automationRunActionTable, key);
  },

  update(
    db: Queryable,
    id: AutomationRunAction['id'],
    changes: AutomationRunActionChanges,
  ): Promise<AutomationRunAction | undefined> {
    return updateRow(db, automationRunActionTable, { id }, changes);
  },

  async listForRuns(db: Queryable, runIds: readonly string[]): Promise<AutomationRunAction[]> {
    if (runIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${automationRunActionTable.select} from automation.automation_run_actions where run_id = any($1::uuid[]) order by run_id, sequence`,
      [[...runIds]]);
    return rows as AutomationRunAction[];
  },
};
