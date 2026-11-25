// Data access for ontology.retirement_reminders, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  retirementReminderTable,
  type NewRetirementReminder,
  type RetirementReminder,
  type RetirementReminderChanges,
} from '../../models/ontology/retirementReminder.model.ts';

export const retirementReminderRepo = {
  insert(db: Queryable, row: NewRetirementReminder): Promise<RetirementReminder> {
    return insertRow(db, retirementReminderTable, row);
  },

  findById(db: Queryable, id: RetirementReminder['id']): Promise<RetirementReminder | undefined> {
    return findRow(db, retirementReminderTable, { id });
  },

  update(db: Queryable, id: RetirementReminder['id'], changes: RetirementReminderChanges): Promise<RetirementReminder | undefined> {
    return updateRow(db, retirementReminderTable, { id }, changes);
  },

  /** Across organisations: reminders due on or before a day (identifiers only), through the definer function. */
  async due(db: Queryable, on: string, limit: number): Promise<{ organisationId: string; id: string }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", id from ontology.retirement_reminders_due($1::date, $2)', [on, limit]);
    return rows as { organisationId: string; id: string }[];
  },

  /** An element retired before its reminder: the reminder is not sent. */
  async cancelOpen(db: Queryable, elementId: string): Promise<number> {
    const { rowCount } = await db.query(
      'update ontology.retirement_reminders set cancelled_at = now() where element_id = $1 and sent_at is null and cancelled_at is null', [elementId]);
    return rowCount ?? 0;
  },
};
