// Data access for automation.automation_actions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  automationActionTable,
  type AutomationAction,
  type AutomationActionChanges,
  type NewAutomationAction,
} from '../../models/automation/automationAction.model.ts';

export const automationActionRepo = {
  insert(db: Queryable, row: NewAutomationAction): Promise<AutomationAction> {
    return insertRow(db, automationActionTable, row);
  },

  findById(db: Queryable, id: AutomationAction['id']): Promise<AutomationAction | undefined> {
    return findRow(db, automationActionTable, { id });
  },

  findByAutomationIdAndSequence(
    db: Queryable,
    key: Pick<AutomationAction, 'organisationId' | 'automationId' | 'sequence'>,
  ): Promise<AutomationAction | undefined> {
    return findRow(db, automationActionTable, key);
  },

  update(
    db: Queryable,
    id: AutomationAction['id'],
    changes: AutomationActionChanges,
  ): Promise<AutomationAction | undefined> {
    return updateRow(db, automationActionTable, { id }, changes);
  },

  /** The Cron's actions in order. */
  async listFor(db: Queryable, automationId: string): Promise<AutomationAction[]> {
    const { rows } = await db.query(
      `select ${automationActionTable.select} from automation.automation_actions where automation_id = $1 order by sequence`, [automationId]);
    return rows as AutomationAction[];
  },
};
