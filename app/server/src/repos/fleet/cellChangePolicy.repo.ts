// Data access for fleet.cell_change_policies, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  cellChangePolicyTable,
  type CellChangePolicy,
  type CellChangePolicyChanges,
  type NewCellChangePolicy,
} from '../../models/fleet/cellChangePolicy.model.ts';

export const cellChangePolicyRepo = {
  insert(db: Queryable, row: NewCellChangePolicy): Promise<CellChangePolicy> {
    return insertRow(db, cellChangePolicyTable, row);
  },

  findByCellId(db: Queryable, cellId: CellChangePolicy['cellId']): Promise<CellChangePolicy | undefined> {
    return findRow(db, cellChangePolicyTable, { cellId });
  },

  update(
    db: Queryable,
    cellId: CellChangePolicy['cellId'],
    changes: CellChangePolicyChanges,
  ): Promise<CellChangePolicy | undefined> {
    return updateRow(db, cellChangePolicyTable, { cellId }, changes);
  },

  /** The cell's policy as last reported, replacing the one before. */
  async put(db: Queryable, row: NewCellChangePolicy): Promise<void> {
    await db.query(
      `insert into fleet.cell_change_policies (cell_id, organisation_id, time_zone, windows, change_authority_membership_id, freezes, exceptions, reported_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (cell_id) do update set organisation_id = excluded.organisation_id, time_zone = excluded.time_zone,
         windows = excluded.windows, change_authority_membership_id = excluded.change_authority_membership_id,
         freezes = excluded.freezes, exceptions = excluded.exceptions, reported_at = excluded.reported_at`,
      [row.cellId, row.organisationId, row.timeZone, JSON.stringify(row.windows), row.changeAuthorityMembershipId ?? null,
        JSON.stringify(row.freezes), JSON.stringify(row.exceptions), row.reportedAt]);
  },
};
