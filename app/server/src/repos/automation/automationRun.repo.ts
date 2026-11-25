// Data access for automation.automation_runs, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  automationRunTable,
  type AutomationRun,
  type AutomationRunChanges,
  type NewAutomationRun,
} from '../../models/automation/automationRun.model.ts';

export const automationRunRepo = {
  insert(db: Queryable, row: NewAutomationRun): Promise<AutomationRun> {
    return insertRow(db, automationRunTable, row);
  },

  findById(db: Queryable, id: AutomationRun['id']): Promise<AutomationRun | undefined> {
    return findRow(db, automationRunTable, { id });
  },

  update(
    db: Queryable,
    id: AutomationRun['id'],
    changes: AutomationRunChanges,
  ): Promise<AutomationRun | undefined> {
    return updateRow(db, automationRunTable, { id }, changes);
  },

  /** Newest first: every run, the skipped and the not-met included (spec 40.9). */
  async history(db: Queryable, automationId: string, limit: number): Promise<AutomationRun[]> {
    const { rows } = await db.query(
      `select ${automationRunTable.select} from automation.automation_runs where automation_id = $1 order by started_at desc, id desc limit $2`,
      [automationId, limit]);
    return rows as AutomationRun[];
  },

  /** Runs of these Crons that started after a moment, newest first: Home's "Crons that fired" (spec 33.7). */
  async startedSince(db: Queryable, automationIds: readonly string[], since: string, limit: number): Promise<AutomationRun[]> {
    if (automationIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${automationRunTable.select} from automation.automation_runs
       where automation_id = any($1::uuid[]) and started_at > $2 order by started_at desc, id desc limit $3`,
      [automationIds, since, limit]);
    return rows as AutomationRun[];
  },
};
