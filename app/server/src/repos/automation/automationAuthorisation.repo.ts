// Data access for automation.automation_authorisations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  automationAuthorisationTable,
  type AutomationAuthorisation,
  type AutomationAuthorisationChanges,
  type NewAutomationAuthorisation,
} from '../../models/automation/automationAuthorisation.model.ts';

export const automationAuthorisationRepo = {
  insert(db: Queryable, row: NewAutomationAuthorisation): Promise<AutomationAuthorisation> {
    return insertRow(db, automationAuthorisationTable, row);
  },

  findById(db: Queryable, id: AutomationAuthorisation['id']): Promise<AutomationAuthorisation | undefined> {
    return findRow(db, automationAuthorisationTable, { id });
  },

  update(
    db: Queryable,
    id: AutomationAuthorisation['id'],
    changes: AutomationAuthorisationChanges,
  ): Promise<AutomationAuthorisation | undefined> {
    return updateRow(db, automationAuthorisationTable, { id }, changes);
  },
};
