// Data access for automation.automation_conditions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  automationConditionTable,
  type AutomationCondition,
  type AutomationConditionChanges,
  type NewAutomationCondition,
} from '../../models/automation/automationCondition.model.ts';

export const automationConditionRepo = {
  insert(db: Queryable, row: NewAutomationCondition): Promise<AutomationCondition> {
    return insertRow(db, automationConditionTable, row);
  },

  findById(db: Queryable, id: AutomationCondition['id']): Promise<AutomationCondition | undefined> {
    return findRow(db, automationConditionTable, { id });
  },

  findByAutomationIdAndParentConditionIdAndSequence(
    db: Queryable,
    key: Pick<AutomationCondition, 'organisationId' | 'automationId' | 'parentConditionId' | 'sequence'>,
  ): Promise<AutomationCondition | undefined> {
    return findRow(db, automationConditionTable, key);
  },

  update(
    db: Queryable,
    id: AutomationCondition['id'],
    changes: AutomationConditionChanges,
  ): Promise<AutomationCondition | undefined> {
    return updateRow(db, automationConditionTable, { id }, changes);
  },

  /** The Cron's condition tree, parents before children, in sibling order. */
  async listFor(db: Queryable, automationId: string): Promise<AutomationCondition[]> {
    const { rows } = await db.query(
      `select ${automationConditionTable.select} from automation.automation_conditions where automation_id = $1
       order by parent_condition_id nulls first, sequence`, [automationId]);
    return rows as AutomationCondition[];
  },
};
