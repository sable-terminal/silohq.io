// Data access for gov.change_policies, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  changePolicyTable,
  type ChangePolicy,
  type ChangePolicyChanges,
  type NewChangePolicy,
} from '../../models/gov/changePolicy.model.ts';

export const changePolicyRepo = {
  insert(db: Queryable, row: NewChangePolicy): Promise<ChangePolicy> {
    return insertRow(db, changePolicyTable, row);
  },

  findByOrganisationId(
    db: Queryable,
    organisationId: ChangePolicy['organisationId'],
  ): Promise<ChangePolicy | undefined> {
    return findRow(db, changePolicyTable, { organisationId });
  },

  update(
    db: Queryable,
    organisationId: ChangePolicy['organisationId'],
    changes: ChangePolicyChanges,
  ): Promise<ChangePolicy | undefined> {
    return updateRow(db, changePolicyTable, { organisationId }, changes);
  },

  /** Every organisation's policy in the cell, as fleet-control takes it (gov.change_policies_for_fleet). */
  async forFleet(db: Queryable, now: string): Promise<{ organisationId: string; policy: unknown }[]> {
    const { rows } = await db.query('select organisation_id as "organisationId", policy from gov.change_policies_for_fleet($1)', [now]);
    return rows as { organisationId: string; policy: unknown }[];
  },
};
